import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
// `createApp` accepts raw environment-shaped config and parses it itself.
// Passing the already parsed AppConfig would feed parsed arrays back into Zod.
const app = createApp();

export default {
  hostname: config.HOST,
  port: config.PORT,
  fetch: app.fetch
};
