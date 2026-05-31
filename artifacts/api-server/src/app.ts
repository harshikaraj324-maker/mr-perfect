import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { join } from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const ALLOWED_ORIGINS = [
  "https://mr-robot-dashboard.pages.dev",
  /^https:\/\/[a-f0-9]+\.mr-robot-dashboard\.pages\.dev$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https:\/\/.*\.replit\.dev$/,
  /^https:\/\/.*\.repl\.co$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.some(o =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    cb(ok ? null : new Error("CORS: origin not allowed"), ok);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const staticDir = join(process.cwd(), "public");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.use((_req, res) => {
    res.sendFile(join(staticDir, "index.html"));
  });
}

export default app;
