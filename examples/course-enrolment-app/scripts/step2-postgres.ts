// Tutorial step 2:   node scripts/step2-postgres.ts   (needs the database from docker-compose.yml, migrated)
import { dbConnInfoFromEnv } from "../src/db.ts";
import { runStep2 } from "../src/step2Demo.ts";

await runStep2(dbConnInfoFromEnv(), console.log);
