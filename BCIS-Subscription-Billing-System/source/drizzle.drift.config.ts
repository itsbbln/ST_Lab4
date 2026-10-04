import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema/index.ts",
  out: "C:/Users/ACER/AppData/Local/Temp/bcis-drift-DAnYL5",
  casing: "snake_case",
  strict: true,
  verbose: false
});
