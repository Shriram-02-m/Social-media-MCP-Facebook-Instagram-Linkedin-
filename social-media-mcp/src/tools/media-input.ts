// Remote MCP requests are served by the Render worker, which must never read
// files chosen by a remote caller. Local stdio callers keep full path support.
//
// Keep this guard in one place and call it before any filesystem or network
// operation so a remote request can never reach `readFile(imagePath)`,
// `readFile(media[].path)`, or `readFile(documentPath)`.

export interface LocalMediaFields {
  imagePath?: string | undefined;
  documentPath?: string | undefined;
  mediaPaths?: ReadonlyArray<string | undefined> | undefined;
}

export const REMOTE_MEDIA_HINT =
  "Remote MCP clients cannot use local filesystem paths. Provide a public HTTPS "
  + "URL (imageUrl, media[].url, or documentUrl). To share a local image or PDF, "
  + "upload it through the web app first and pass the returned HTTPS URL.";

/**
 * Throws when a remote MCP caller supplies a local filesystem path.
 *
 * @param remote true when serving the remote Streamable HTTP endpoint
 * @param fields local-path fields present in the tool arguments
 */
export function rejectRemoteLocalPaths(remote: boolean, fields: LocalMediaFields): void {
  if (!remote) return;
  const rejected: string[] = [];
  if (fields.imagePath) rejected.push("imagePath");
  if (fields.documentPath) rejected.push("documentPath");
  if (fields.mediaPaths?.some((value) => Boolean(value))) rejected.push("media[].path");
  if (rejected.length) {
    throw new Error(
      `Local filesystem paths are not accepted over remote MCP (${rejected.join(", ")}). ${REMOTE_MEDIA_HINT}`,
    );
  }
}