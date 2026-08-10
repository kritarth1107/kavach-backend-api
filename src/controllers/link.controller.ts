import { Request, Response } from "express";

const notImplemented = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
};

export const getLinkBySlug = notImplemented;
export const createShareLink = notImplemented;
export const getDocumentLinks = notImplemented;
export const updateShareLink = notImplemented;
export const deleteShareLink = notImplemented;
