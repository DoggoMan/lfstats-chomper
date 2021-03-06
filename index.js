const aws = require("aws-sdk");
const readline = require("readline");
const moment = require("moment");
const iconv = require("iconv-lite");
const AutoDetectDecoderStream = require("autodetect-decoder-stream");
const { createPool, sql } = require("slonik");

const targetBucket = process.env.TARGET_BUCKET;
const connectionString = process.env.DATABASE_URL;

const s3 = new aws.S3({ apiVersion: "2006-03-01" });

const pool = createPool(connectionString);

exports.handler = async (event, context) => {
  console.log("BEGIN CHOMP");
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(
    event.Records[0].s3.object.key.replace(/\+/g, " ")
  );

  const eventId = key.split("/")[0];

  const params = {
    Bucket: bucket,
    Key: key
  };

  const jobId = context.awsRequestId;

  var entities = new Map();
  var teams = new Map();
  var game = {};
  var actions = [];
  var game_deltas = [];
  var gameId = null;
  const ENTITY_TYPES = {
    1: "Commander",
    2: "Heavy Weapons",
    3: "Scout",
    4: "Ammo Carrier",
    5: "Medic"
  };

  async function chompFile(rl) {
    return new Promise(resolve => {
      rl.on("line", line => {
        let record = line.split("\t");
        if (record[0].includes(';"')) {
          return;
        } else {
          if (record[0] == 0) {
            //;0/version	file-version	program-version
            game = {
              center: record[3]
            };
          } else if (record[0] == 1) {
            //;1/mission	type	desc	start duration
            game = {
              type: record[1],
              desc: record[2],
              start: parseInt(record[3]),
              starttime: moment(record[3], "YYYYMMDDHHmmss").format(),
              duration: record[4],
              ...game
            };
          } else if (record[0] == 2) {
            //;2/team	index	desc	colour-enum	colour-desc
            //normalize the team colors to either red or green because reasons
            let normal_team = "";
            if (record[4] == "Fire" || record[4] == "Red") {
              normal_team = "red";
            } else if (
              record[4] == "Ice" ||
              record[4] == "Yellow" ||
              record[4] == "Blue" ||
              record[4] == "Green" ||
              record[4] == "Earth"
            ) {
              normal_team = "green";
            }

            let team = {
              index: record[1],
              desc: record[2],
              color_enum: record[3],
              color_desc: record[4],
              score: 0,
              livesLeft: 0,
              normal_team: normal_team,
              lfstats_id: null
            };
            teams.set(team.index, team);
          } else if (record[0] == 3) {
            //;3/entity-start	time	id	type	desc	team	level	category
            let entity = {
              start: parseInt(record[1]),
              ipl_id: record[2],
              type: record[3],
              desc: record[4],
              team: record[5],
              level: parseInt(record[6]),
              category: record[7],
              position: ENTITY_TYPES[record[7]],
              lfstats_id: null,
              resupplies: 0,
              bases_destroyed: 0,
              hits: new Map()
            };
            entities.set(entity.ipl_id, entity);
          } else if (record[0] == 4) {
            //;4/event	time	type	varies
            let action = {
              time: record[1],
              type: record[2],
              player: null,
              action: null,
              target: null,
              team: null
            };

            let player = null;

            if (record[2] == "0100" || record[2] == "0101") {
              action.action = record[3];
            } else {
              player = entities.get(record[3]);
              action.player = record[3];
              action.team = player.team;
              action.action = record[4];
              action.target =
                typeof record[5] != "undefined" ? record[5] : null;
            }

            actions.push(action);

            //track and total hits
            if (
              record[2] == "0205" ||
              record[2] == "0206" ||
              record[2] == "0306"
            ) {
              let target = entities.get(record[5]);

              if (!player.hits.has(target.ipl_id)) {
                player.hits.set(target.ipl_id, {
                  ipl_id: target.ipl_id,
                  hits: 0,
                  missiles: 0
                });
              }

              if (record[2] == "0205" || record[2] == "0206")
                player.hits.get(target.ipl_id).hits += 1;
              if (record[2] == "0306")
                player.hits.get(target.ipl_id).missiles += 1;
            }

            //compute game start, end and length
            if (record[2] == "0101") {
              let gameLength;
              gameLength = (Math.round(record[1] / 1000) * 1000) / 1000;
              game.endtime = moment(game.start, "YYYYMMDDHHmmss")
                .seconds(gameLength)
                .format();
              game.gameLength = gameLength;
            }

            //sum up total resupplies
            if (record[2] == "0500" || record[2] == "0502") {
              entities.get(record[3]).resupplies += 1;
            }

            //sum up total bases destroyed
            if (record[2] == "0303" || record[2] == "0204") {
              entities.get(record[3]).bases_destroyed += 1;
            }
          } else if (record[0] == 5) {
            let player = entities.get(record[2]);
            //;5/score	time	entity	old	delta	new
            game_deltas.push({
              time: record[1],
              player: record[2],
              team: player.team,
              old: record[3],
              delta: record[4],
              new: record[5]
            });
          } else if (record[0] == 6) {
            //;6/entity-end	time	id	type	score
            let player = entities.get(record[2]);
            player = {
              end: parseInt(record[1]),
              score: parseInt(record[4]),
              survived:
                (Math.round((record[1] - player.start) / 1000) * 1000) / 1000,
              ...player
            };
            entities.set(player.ipl_id, player);
          } else if (record[0] == 7) {
            //;7/sm5-stats	id	shotsHit	shotsFired	timesZapped	timesMissiled	missileHits	nukesDetonated	nukesActivated	nukeCancels	medicHits	ownMedicHits	medicNukes	scoutRapid	lifeBoost	ammoBoost	livesLeft	shotsLeft	penalties	shot3Hit	ownNukeCancels	shotOpponent	shotTeam	missiledOpponent	missiledTeam
            let player = entities.get(record[1]);
            player = {
              accuracy: parseInt(record[2]) / Math.max(parseInt(record[3]), 1),
              hit_diff: parseInt(record[21]) / Math.max(parseInt(record[4]), 1),
              sp_earned:
                parseInt(record[21]) +
                parseInt(record[23]) * 2 +
                player.bases_destroyed * 5,
              sp_spent:
                parseInt(record[8]) * 20 +
                parseInt(record[14]) * 10 +
                parseInt(record[15]) * 15,
              shotsHit: parseInt(record[2]),
              shotsFired: parseInt(record[3]),
              timesZapped: parseInt(record[4]),
              timesMissiled: parseInt(record[5]),
              missileHits: parseInt(record[6]),
              nukesDetonated: parseInt(record[7]),
              nukesActivated: parseInt(record[8]),
              nukeCancels: parseInt(record[9]),
              medicHits: parseInt(record[10]),
              ownMedicHits: parseInt(record[11]),
              medicNukes: parseInt(record[12]),
              scoutRapid: parseInt(record[13]),
              lifeBoost: parseInt(record[14]),
              ammoBoost: parseInt(record[15]),
              livesLeft: parseInt(record[16]),
              shotsLeft: parseInt(record[17]),
              penalties: parseInt(record[18]),
              shot3Hit: parseInt(record[19]),
              ownNukeCancels: parseInt(record[20]),
              shotOpponent: parseInt(record[21]),
              shotTeam: parseInt(record[22]),
              missiledOpponent: parseInt(record[23]),
              missiledTeam: parseInt(record[24]),
              ...player
            };
            //adjsut for penalties
            if (player.penalties > 0) {
              player.score += record[18] * 1000;
            }
            entities.set(record[1], player);
            teams.get(player.team).livesLeft += player.livesLeft;
            teams.get(player.team).score += player.score;
          }
        }
      });
      rl.on("error", () => {
        console.log("READ ERROR");
      });
      rl.on("close", async () => {
        console.log("READ COMPLETE");
        resolve();
      });
    });
  }

  await pool.connect(async connection => {
    await connection.query(sql`
      INSERT INTO game_imports (id, filename, status)
      VALUES (${jobId}, ${key}, ${"starting chomp..."})
    `);

    try {
      const rl = readline.createInterface({
        input: s3
          .getObject(params)
          .createReadStream()
          .pipe(new AutoDetectDecoderStream())
          .pipe(iconv.encodeStream("utf8")),
        terminal: false
      });

      await chompFile(rl);

      const storageParams = {
        CopySource: bucket + "/" + key,
        Bucket: targetBucket,
        Key: `${game.center}_${game.start}_${game.desc.replace(/ /g, "-")}.tdf`
      };

      await s3
        .copyObject(storageParams)
        .promise()
        .then(data => console.log("MOVED TDF TO ARCHIVE", data))
        .catch(err => console.log(err, err.stack));

      await s3
        .deleteObject(params)
        .promise()
        .then(data => console.log("REMOVED TDF", data))
        .catch(err => console.log(err, err.stack));

      //IMPORT PROCESS
      await connection.query(sql`
        UPDATE game_imports
        SET status = ${"importing game..."}
        WHERE id = ${jobId}
      `);

      //Let's see if the game already exists before we start doing too much
      let gameExist = await connection.maybeOne(
        sql`SELECT games.id 
            FROM games 
            INNER JOIN centers ON games.center_id=centers.id 
            WHERE game_datetime=${game.starttime} AND centers.ipl_id=${game.center}`
      );

      if (gameExist != null) {
        console.log("CHOMP ABORTED: game exists");
        await connection.query(sql`
          UPDATE game_imports
          SET status = ${"game exists, import aborted"}, job_end=now()
          WHERE id = ${jobId}
        `);
        return;
      }

      let event = await connection.one(sql`
        SELECT *
        FROM events 
        WHERE id=${eventId}
      `);

      await connection.query(sql`
        UPDATE game_imports
        SET center_id=${event.center_id}
        WHERE id = ${jobId}
      `);

      let playerRecords = await connection.transaction(async client => {
        //find or create lfstats player IDs
        //baller screaver optimization
        return await client.query(sql`
          INSERT INTO players (player_name,ipl_id) 
          VALUES (
            ${sql.join(
              [...entities]
                .filter(
                  p => p[1].type === "player" && p[1].ipl_id.startsWith("#")
                )
                .sort()
                .map(p => sql.join([p[1].desc, p[1].ipl_id], sql`, `)),
              sql`), (`
            )}
          )
          ON CONFLICT (ipl_id) DO UPDATE SET player_name=excluded.player_name
          RETURNING *
        `);
      });

      //assign out the lfstats IDs to our entities object so we can use them later
      for (let [, player] of entities) {
        if (player.type == "player" && player.ipl_id.startsWith("@"))
          //not a member, so assign the generic player id
          player.lfstats_id = 0;
      }

      //update the rest of our entities with their lfstats IDs
      for (let player of playerRecords.rows) {
        entities.get(player.ipl_id).lfstats_id = player.id;
      }

      //upsert aliases
      await connection.transaction(async client => {
        return await client.query(sql`
          INSERT INTO players_names (player_id,player_name,is_active) 
          VALUES 
          (
            ${sql.join(
              [...entities]
                .filter(
                  p => p[1].type === "player" && p[1].ipl_id.startsWith("#")
                )
                .sort()
                .map(p =>
                  sql.join([p[1].lfstats_id, p[1].desc, true], sql`, `)
                ),
              sql`), (`
            )} 
          )
          ON CONFLICT (player_id,player_name) DO UPDATE SET is_active=true
        `);
      });

      await connection.transaction(async client => {
        //start working on game details pre-insert
        //need to normalize team colors and determine elims before inserting the game
        let redTeam;
        let greenTeam;
        // eslint-disable-next-line no-unused-vars
        for (const [key, value] of teams) {
          if (value.normal_team == "red") redTeam = value;
          if (value.normal_team == "green") greenTeam = value;
        }

        //Assign elim bonuses
        let greenBonus = 0,
          redBonus = 0;
        let redElim = 0,
          greenElim = 0;
        if (redTeam.livesLeft == 0) {
          greenBonus = 10000;
          redElim = 1;
        }
        if (greenTeam.livesLeft == 0) {
          redBonus = 10000;
          greenElim = 1;
        }

        //assign a winner
        let winner = "";
        //if both teams were elimed or neither were, we go to score
        //otherwise, winner determined by elim regardless of score
        if (redElim == greenElim) {
          if (redTeam.score + redBonus > greenTeam.score + greenBonus)
            winner = "red";
          else winner = "green";
        } else if (redElim) winner = "green";
        else if (greenElim) winner = "red";
        game.name = `Game @ ${moment(game.starttime).format("HH:mm")}`;

        let gameRecord = await client.query(sql`
          INSERT INTO games 
            (game_name,game_description,game_datetime,game_length,duration,red_score,green_score,red_adj,green_adj,winner,red_eliminated,green_eliminated,type,center_id,event_id)
          VALUES
            (${game.name},'',${game.starttime},${game.gameLength},${game.duration},${redTeam.score},${greenTeam.score},${redBonus},${greenBonus},${winner},${redElim},${greenElim},${event.type},${event.center_id},${event.id})
          RETURNING *
        `);
        let newGame = gameRecord.rows[0];
        gameId = newGame.id;

        await client.query(sql`
          UPDATE game_imports
          SET status = ${"importing actions..."}
          WHERE id = ${jobId}
        `);

        //insert the actions
        //for (const action of actions) {
        let chunkSize = 100;
        for (let i = 0, len = actions.length; i < len; i += chunkSize) {
          let chunk = actions.slice(i, i + chunkSize);
          await client.query(sql`
            INSERT INTO game_actions
              (action_time, action_type, action_text, player, target, team_index, game_id) 
            VALUES (
              ${sql.join(
                chunk.map(action =>
                  sql.join(
                    [
                      action.time,
                      action.type,
                      action.action,
                      action.player,
                      action.target,
                      action.team,
                      newGame.id
                    ],
                    sql`, `
                  )
                ),
                sql`), (`
              )}
            )
          `);
        }

        //insert the score deltas
        for (let i = 0, len = game_deltas.length; i < len; i += chunkSize) {
          let chunk = game_deltas.slice(i, i + chunkSize);
          await client.query(sql`
            INSERT INTO game_deltas
              (score_time, old, delta, new, ipl_id, player_id, team_index, game_id) 
            VALUES (
              ${sql.join(
                chunk.map(delta =>
                  sql.join(
                    [
                      delta.time,
                      delta.old,
                      delta.delta,
                      delta.new,
                      delta.player,
                      null,
                      delta.team,
                      newGame.id
                    ],
                    sql`, `
                  )
                ),
                sql`), (`
              )}
            )
          `);
        }

        //store non-player objects
        //should be referees and targets/generators
        await client.query(sql`
          INSERT INTO game_objects (ipl_id,name,type,team,level,category,game_id) 
          VALUES 
          (
            ${sql.join(
              [...entities]
                .filter(r => r[1].type != "player")
                .map(r =>
                  sql.join(
                    [
                      r[1].ipl_id,
                      r[1].desc,
                      r[1].type,
                      r[1].team,
                      r[1].level,
                      r[1].category,
                      newGame.id
                    ],
                    sql`, `
                  )
                ),
              sql`), (`
            )} 
          )
        `);

        //insert the teams
        let teamRecords = await client.query(sql`
          INSERT INTO game_teams (index,name,color_enum,color_desc,color_normal,game_id) 
          VALUES 
          (
            ${sql.join(
              [...teams].map(t =>
                sql.join(
                  [
                    t[1].index,
                    t[1].desc,
                    t[1].color_enum,
                    t[1].color_desc,
                    t[1].normal_team,
                    newGame.id
                  ],
                  sql`, `
                )
              ),
              sql`), (`
            )} 
          )
          RETURNING *
        `);

        for (let team of teamRecords.rows) {
          teams.get(`${team.index}`).lfstats_id = team.id;
          await client.query(sql`
            UPDATE game_actions
            SET team_id = ${team.id}
            WHERE team_index = ${team.index}
              AND
                  game_id = ${newGame.id}
          `);
          await client.query(sql`
            UPDATE game_deltas
            SET team_id = ${team.id}
            WHERE team_index = ${team.index}
              AND
                  game_id = ${newGame.id}
        `);
        }

        await client.query(sql`
          UPDATE game_imports
          SET status = ${"importing scorecards..."}
          WHERE id = ${jobId}
        `);

        //insert the scorecards
        // eslint-disable-next-line no-unused-vars
        for (const [key, player] of entities) {
          if (player.type == "player") {
            let team = teams.get(player.team);

            let team_elim = 0;
            let elim_other_team = 0;
            if (
              (redElim && team.normal_team == "red") ||
              (greenElim && team.normal_team == "green")
            )
              team_elim = 1;
            if (
              (redElim && team.normal_team == "green") ||
              (greenElim && team.normal_team == "red")
            )
              elim_other_team = 1;

            let scorecardRecord = await client.query(sql`
                  INSERT INTO scorecards
                    (
                      player_name,
                      game_datetime,
                      team,
                      position,
                      survived,
                      shots_hit,
                      shots_fired,
                      times_zapped,
                      times_missiled,
                      missile_hits,
                      nukes_activated,
                      nukes_detonated,
                      nukes_canceled,
                      medic_hits,
                      own_medic_hits,
                      medic_nukes,
                      scout_rapid,
                      life_boost,
                      ammo_boost,
                      lives_left,
                      score,
                      max_score,
                      shots_left,
                      penalty_count,
                      shot_3hit,
                      elim_other_team,
                      team_elim,
                      own_nuke_cancels,
                      shot_opponent,
                      shot_team,
                      missiled_opponent,
                      missiled_team,
                      resupplies,
                      rank,
                      bases_destroyed,
                      accuracy,
                      hit_diff,
                      mvp_points,
                      mvp_details,
                      sp_earned,
                      sp_spent,
                      game_id,
                      type,
                      player_id,
                      center_id,
                      event_id,
                      team_id
                    )
                  VALUES
                    (
                      ${player.desc},
                      ${game.starttime},
                      ${team.normal_team},
                      ${player.position},
                      ${player.survived},
                      ${player.shotsHit},
                      ${player.shotsFired},
                      ${player.timesZapped},
                      ${player.timesMissiled},
                      ${player.missileHits},
                      ${player.nukesActivated},
                      ${player.nukesDetonated},
                      ${player.nukeCancels},
                      ${player.medicHits},
                      ${player.ownMedicHits},
                      ${player.medicNukes},
                      ${player.scoutRapid},
                      ${player.lifeBoost},
                      ${player.ammoBoost},
                      ${player.livesLeft},
                      ${player.score},
                      0,
                      ${player.shotsLeft},
                      ${player.penalties},
                      ${player.shot3Hit},
                      ${elim_other_team},
                      ${team_elim},
                      ${player.ownNukeCancels},
                      ${player.shotOpponent},
                      ${player.shotTeam},
                      ${player.missiledOpponent},
                      ${player.missiledTeam},
                      ${player.resupplies},
                      0,
                      ${player.bases_destroyed},
                      ${player.accuracy},
                      ${player.hit_diff},
                      0,
                      ${null},
                      ${player.sp_earned},
                      ${player.sp_spent},
                      ${newGame.id},
                      ${event.type},
                      ${player.lfstats_id},
                      ${event.center_id},
                      ${event.id},
                      ${team.lfstats_id}
                    )
                    RETURNING *
                `);
            player.scorecard_id = scorecardRecord.rows[0].id;
          }
        }

        //Let's iterate through the entities and make some udpates in the database
        // eslint-disable-next-line no-unused-vars
        for (let [key, player] of entities) {
          if (player.type == "player") {
            //1-Tie an internal lfstats id to players and targets in each action
            await client.query(sql`
                  UPDATE game_actions
                  SET player_id = ${player.lfstats_id}
                  WHERE player = ${player.ipl_id}
                    AND
                        game_id = ${newGame.id}
                `);
            await client.query(sql`
                  UPDATE game_actions
                  SET target_id = ${player.lfstats_id}
                  WHERE target = ${player.ipl_id}
                    AND
                        game_id = ${newGame.id}
                `);
            //2-Tie an internal lfstats id to each score delta
            await client.query(sql`
                  UPDATE game_deltas
                  SET player_id = ${player.lfstats_id}
                  WHERE ipl_id = ${player.ipl_id}
                    AND
                        game_id = ${newGame.id}
                `);
            //3-insert the hit and missile stats for each player
            // eslint-disable-next-line no-unused-vars
            for (let [key, target] of player.hits) {
              if (entities.has(target.ipl_id)) {
                target.target_lfstats_id = entities.get(
                  target.ipl_id
                ).lfstats_id;
              }
              await client.query(sql`
                  INSERT INTO hits
                    (player_id, target_id, hits, missiles, scorecard_id)
                  VALUES
                    (${player.lfstats_id}, ${target.target_lfstats_id}, ${target.hits}, ${target.missiles}, ${player.scorecard_id})
                `);
            }
            //4-fix penalties
            if (player.penalties > 0) {
              let penalties = await client.many(sql`
                    SELECT *
                    FROM game_deltas
                    WHERE game_id = ${newGame.id}
                      AND
                        player_id = ${player.lfstats_id}
                      AND
                        delta = -1000
                    ORDER BY score_time ASC
                  `);

              for (const penalty of penalties) {
                //log the penalty - just going to use the common defaults
                await client.query(sql`
                      INSERT INTO penalties
                        (scorecard_id)
                      VALUES
                        (${player.scorecard_id})
                    `);

                //Now the tricky bit, have to rebuild the score deltas from the point the penalty occurred
                //update the delta event to remove the -1000
                await client.query(sql`
                      UPDATE game_deltas 
                      SET delta=0,new=new+1000 
                      WHERE id=${penalty.id}
                    `);
                //Now update a lot of rows, so scary
                await client.query(sql`
                      UPDATE game_deltas 
                      SET old=old+1000,new=new+1000 
                      WHERE game_id = ${newGame.id}
                        AND
                          player_id = ${player.lfstats_id}
                        AND
                          score_time>${penalty.score_time}
                    `);
              }
            }
          }
        }

        await client.query(sql`
          UPDATE game_imports
          SET status = ${"calculating mvp..."}
          WHERE id = ${jobId}
        `);

        //calc mvp - lets fuckin go bro, the good shit aw yiss
        let scorecards = await client.many(sql`
              SELECT *
              FROM scorecards
              WHERE game_id = ${newGame.id}
            `);

        for (const scorecard of scorecards) {
          //instantiate the fuckin mvp object bro
          let mvp = 0;
          let mvpDetails = {
            positionBonus: {
              name: "Position Score Bonus",
              value: 0
            },
            missiledOpponent: {
              name: "Missiled Opponent",
              value: 0
            },
            acc: {
              name: "Accuracy",
              value: 0
            },
            nukesDetonated: {
              name: "Nukes Detonated",
              value: 0
            },
            nukesCanceled: {
              name: "Nukes Canceled",
              value: 0
            },
            medicHits: {
              name: "Medic Hits",
              value: 0
            },
            ownMedicHits: {
              name: "Own Medic Hits",
              value: 0
            },
            /*rapidFire: {
              name: "Activate Rapid Fire",
              value: 0
            },*/
            shoot3Hit: {
              name: "Shoot 3-Hit",
              value: 0
            },
            ammoBoost: {
              name: "Ammo Boost",
              value: 0
            },
            lifeBoost: {
              name: "Life Boost",
              value: 0
            },
            medicSurviveBonus: {
              name: "Medic Survival Bonus",
              value: 0
            },
            medicScoreBonus: {
              name: "Medic Score Bonus",
              value: 0
            },
            elimBonus: {
              name: "Elimination Bonus",
              value: 0
            },
            timesMissiled: {
              name: "Times Missiled",
              value: 0
            },
            missiledTeam: {
              name: "Missiled Team",
              value: 0
            },
            ownNukesCanceled: {
              name: "Your Nukes Canceled",
              value: 0
            },
            teamNukesCanceled: {
              name: "Team Nukes Canceled",
              value: 0
            },
            elimPenalty: {
              name: "Elimination Penalty",
              value: 0
            },
            penalties: {
              name: "Penalties",
              value: 0
            }
          };

          //POSITION BASED SCORE BONUS OMFG GIT GUD
          switch (scorecard.position) {
            case "Ammo Carrier":
              mvpDetails.positionBonus.value += Math.max(
                Math.floor((scorecard.score - 3000) / 10) * 0.01,
                0
              );
              break;
            case "Commander":
              mvpDetails.positionBonus.value += Math.max(
                Math.floor((scorecard.score - 10000) / 10) * 0.01,
                0
              );
              break;
            case "Heavy Weapons":
              mvpDetails.positionBonus.value += Math.max(
                Math.floor((scorecard.score - 7000) / 10) * 0.01,
                0
              );
              break;
            case "Medic":
              mvpDetails.positionBonus.value += Math.max(
                Math.floor((scorecard.score - 2000) / 10) * 0.02,
                0
              );
              break;
            case "Scout":
              mvpDetails.positionBonus.value += Math.max(
                Math.floor((scorecard.score - 6000) / 10) * 0.01,
                0
              );
              break;
          }

          //medic bonus score point - removed on 2020-02-22
          /*if ("Medic" == scorecard.position && scorecard.score >= 3000) {
            mvpDetails.medicScoreBonus.value += 1;
          }*/

          //accuracy bonus
          mvpDetails.acc.value += Math.round(scorecard.accuracy * 100) / 10;

          //don't get missiled dummy
          mvpDetails.timesMissiled.value += scorecard.times_missiled * -1;

          //missile other people instead
          switch (scorecard.position) {
            case "Commander":
              mvpDetails.missiledOpponent.value += scorecard.missiled_opponent;
              break;
            case "Heavy Weapons":
              mvpDetails.missiledOpponent.value +=
                scorecard.missiled_opponent * 2;
              break;
          }

          //get dat 5-chain
          mvpDetails.nukesDetonated.value += scorecard.nukes_detonated;

          //maybe hide better
          if (scorecard.nukes_activated - scorecard.nukes_detonated > 0) {
            let team = "red" == scorecard.team ? "green" : "red";

            let nukes = await client.any(sql`
                  SELECT SUM(nukes_canceled) as all_nukes_canceled
                  FROM scorecards
                  WHERE game_id = ${newGame.id} AND team = ${team}
                `);

            if (nukes.all_nukes_canceled > 0) {
              mvpDetails.ownNukesCanceled.value +=
                nukes.all_nukes_canceled * -3;
            }
          }

          //make commanders cry
          mvpDetails.nukesCanceled.value += scorecard.nukes_canceled * 3;

          //medic tears are scrumptious
          mvpDetails.medicHits.value += scorecard.medic_hits;

          //dont be a venom
          mvpDetails.ownMedicHits.value += scorecard.own_medic_hits * -1;

          //push the little button
          //mvpDetails.rapidFire.value += scorecard.scout_rapid * 0.5;
          mvpDetails.lifeBoost.value += scorecard.life_boost * 3;
          mvpDetails.ammoBoost.value += scorecard.ammo_boost * 3;

          //survival bonuses/penalties
          if (scorecard.lives_left > 0 && "Medic" == scorecard.position) {
            mvpDetails.medicSurviveBonus.value += 2;
          }

          if (scorecard.lives_left <= 0 && "Medic" != scorecard.position) {
            mvpDetails.elimPenalty.value += -1;
          }

          //apply penalties based on value of the penalty
          let playerPenalties = await client.any(sql`
                SELECT *
                FROM penalties
                WHERE scorecard_id = ${scorecard.id}
              `);
          for (let penalty of playerPenalties) {
            if ("Penalty Removed" != penalty.type) {
              mvpDetails.penalties.value += penalty.mvp_value;
            }
          }

          //raping 3hits.  the math looks weird, but it works and gets the desired result
          mvpDetails.shoot3Hit.value +=
            Math.floor((scorecard.shot_3hit / 5) * 100) / 100;

          //One time DK, one fucking time.
          mvpDetails.teamNukesCanceled.value += scorecard.own_nuke_cancels * -3;

          //more venom points
          mvpDetails.missiledTeam.value += scorecard.missiled_team * -3;

          //WINNER
          //at least 1 MVP for an elim, increased by 1/60 for each second of time remaining over 60
          if (scorecard.elim_other_team > 0)
            mvpDetails.elimBonus.value += Math.max(
              1,
              (900 - newGame.game_length) / 60
            );

          //sum it up and insert
          for (const prop in mvpDetails) {
            mvp += mvpDetails[prop].value;
          }

          await client.query(sql`
                UPDATE scorecards
                SET mvp_points=${mvp}, mvp_details=${JSON.stringify(mvpDetails)}
                WHERE id = ${scorecard.id}
              `);
        }
      });

      console.log("CHOMP COMPLETE");

      await connection.query(sql`
        UPDATE game_imports
        SET status = ${"success"},job_end=now(),game_id=${gameId}
        WHERE id = ${jobId}
      `);
    } catch (err) {
      console.log("CHOMP ERROR", err.stack);
      await pool.connect(async connection => {
        await connection.query(sql`
        UPDATE game_imports
        SET status = ${"failed"},job_end=now()
        WHERE id = ${jobId}
      `);
      });
    }
  });
};
