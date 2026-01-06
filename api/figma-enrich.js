export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const relayKey = req.headers["x-relay-key"];
    if (relayKey !== process.env.RELAY_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const fileKey = req.query.file_key;
    const depth = req.query.depth || "1";
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 25);

    if (!fileKey) {
      return res.status(400).json({ error: "Missing file_key" });
    }

    const figmaHeaders = {
      "X-Figma-Token": process.env.FIGMA_PAT,
      "Accept": "application/json"
    };

    // 1) Fetch file (server-side)
    const fileResp = await fetch(
      `https://api.figma.com/v1/files/${fileKey}?depth=${depth}`,
      { headers: figmaHeaders }
    );

    if (!fileResp.ok) {
      return res.status(fileResp.status).json({ error: "Figma file fetch failed" });
    }

    const fileJson = await fileResp.json();

    // 2) Discover top-level screens
    const screens = [];
    for (const page of fileJson.document.children || []) {
      if (page.type !== "CANVAS") continue;
      for (const node of page.children || []) {
        if (["FRAME", "SECTION"].includes(node.type)) {
          screens.push({ id: node.id, name: node.name });
          if (screens.length >= limit) break;
        }
      }
      if (screens.length >= limit) break;
    }

    // 3) Fetch nodes selectively
    const ids = screens.map(s => s.id).join(",");
    let nodes = {};

    if (ids) {
      const nodesResp = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${ids}`,
        { headers: figmaHeaders }
      );
      if (nodesResp.ok) {
        const nodesJson = await nodesResp.json();
        nodes = nodesJson.nodes || {};
      }
    }

    return res.status(200).json({
      file_key: fileKey,
      file_name: fileJson.name,
      screens,
      nodes
    });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error", detail: String(e) });
  }
}


