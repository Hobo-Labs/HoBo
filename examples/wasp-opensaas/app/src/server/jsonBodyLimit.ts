import type { NextFunction, Request, Response } from "express";
import express from "express";
import { type MiddlewareConfigFn } from "wasp/server";
import { maxProfilePhotoBytes } from "../admin/elements/settings/adminProfile";

const profileJsonLimitChars = Math.ceil(maxProfilePhotoBytes / 3) * 4 + 8192;
const defaultJsonParser = express.json();
const profileJsonParser = express.json({ limit: `${profileJsonLimitChars}b` });

const saveAdminProfileOperationPath = "/operations/save-admin-profile";

function routeJsonParser(req: Request, res: Response, next: NextFunction) {
  const parser =
    req.method === "POST" && req.path === saveAdminProfileOperationPath
      ? profileJsonParser
      : defaultJsonParser;
  return parser(req, res, next);
}

export const jsonBodyLimitMiddlewareConfigFn: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.set("express.json", routeJsonParser);
  return middlewareConfig;
};