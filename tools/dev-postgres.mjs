// Local development/test PostgreSQL using embedded-postgres (no Docker). Data in .data/pg, port 5434.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
const dir = new URL("../.data/pg", import.meta.url).pathname;
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "recart", password: "recart-dev", port: 5434, persistent: true });
if (!existsSync(dir + "/PG_VERSION")) await pg.initialise();
await pg.start();
for (const db of ["recart", "recart_test"]) { try { await pg.createDatabase(db); console.log("created database", db); } catch { /* exists */ } }
console.log("embedded postgres ready on 127.0.0.1:5434 (user recart)");
const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
