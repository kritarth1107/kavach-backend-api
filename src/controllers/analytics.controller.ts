import { Request, Response } from "express";

const notImplemented = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
};

export const trackView = notImplemented;
export const getDocumentAnalytics = notImplemented;
export const getLinkAnalytics = notImplemented;
