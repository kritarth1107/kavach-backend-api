import { Request, Response } from "express";

export const getUserDocuments = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
};

export const uploadDocument = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
};

export const upload = {
  single: (_field: string) => (_req: Request, _res: Response, next: () => void) =>
    next(),
};
