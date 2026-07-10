import { migrate, closeDb } from "./index.js";

migrate()
  .then(() => {
    console.log("Migration complete.");
    return closeDb();
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
