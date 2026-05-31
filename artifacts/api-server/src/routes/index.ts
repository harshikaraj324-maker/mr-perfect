import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import { sseHandler } from "../lib/sseEmitter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.get("/events", sseHandler);

export default router;
