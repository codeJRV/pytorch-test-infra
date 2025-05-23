import fetchS3Links from "lib/fetchS3Links";
import { Artifact } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Artifact[]>
) {
  res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=300")
    .json(await fetchS3Links(req.query.workflowId as string));
}
