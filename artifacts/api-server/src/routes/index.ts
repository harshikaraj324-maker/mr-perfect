import { Router, type IRouter } from "express";
  import healthRouter from "./health";
  import relayRouter from "./relay";

  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(relayRouter);

  export default router;
  