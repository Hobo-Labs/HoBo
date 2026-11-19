import express from "express";
import { type MiddlewareConfigFn } from "wasp/server";
import { maxProfilePhotoBytes } from "../admin/elements/settings/adminProfile";

const jsonBodyLimitChars = Math.ceil(maxProfilePhotoBytes / 3) * 4 + 8192;

export const jsonBodyLimitMiddlewareConfigFn: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.delete("express.json");
  middlewareConfig.set(
    "express.json",
    express.json({ limit: `${jsonBodyLimitChars}b` }),
  );
  return middlewareConfig;
};