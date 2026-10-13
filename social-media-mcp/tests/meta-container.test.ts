import assert from "node:assert/strict";
import test from "node:test";
import { waitForInstagramContainer } from "../src/platforms/meta.js";

async function withInstagramStatuses<T>(
  statuses: string[],
  run: () => Promise<T>,
): Promise<{ result: T; requests: number }> {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_input: RequestInfo | URL): Promise<Response> => {
    const status = statuses[requests++];
    if (!status) throw new Error("Unexpected additional Instagram status request.");
    return Response.json({ status_code: status });
  };
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("publishing waits until Instagram reports the container is finished", async () => {
  const { requests } = await withInstagramStatuses(["IN_PROGRESS", "FINISHED"], () =>
    waitForInstagramContainer("container-id", "access-token"),
  );
  assert.equal(requests, 2);
});

test("Instagram container processing errors fail before publish", async () => {
  await withInstagramStatuses(["ERROR"], () =>
    assert.rejects(waitForInstagramContainer("container-id", "access-token"), /status ERROR/),
  );
});
