// Tutorial step 2:   node scripts/step2-postgres.ts   (needs the database from docker-compose.yml, migrated)
import * as Crablet from "@crablet/app";
import { readCourseDatabase } from "../src/config.ts";
import { runStep2 } from "../src/step2Demo.ts";

await runStep2(Crablet.plainConnection((await readCourseDatabase()).pg), console.log);
