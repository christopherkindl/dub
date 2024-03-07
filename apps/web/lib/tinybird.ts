import {
  LOCALHOST_GEO_DATA,
  capitalize,
  getDomainWithoutWWW,
} from "@dub/utils";
import { NextRequest, userAgent } from "next/server";
import { getIdentityHash } from "./edge";
import { detectBot } from "./middleware/utils";
import { conn } from "./planetscale";
import { LinkProps } from "./types";
import { ratelimit } from "./upstash";
import { generateClickId } from "./analytics";

/**
 * Recording clicks with geo, ua, referer and timestamp data
 **/
export async function recordClick({
  req,
  id,
  url,
  root,
  clickId,
  affiliateId,
}: {
  req: NextRequest;
  id: string;
  url?: string;
  root?: boolean;
  clickId?: string;
  affiliateId?: string;
}) {
  const isBot = detectBot(req);
  if (isBot) {
    return null;
  }
  const geo = process.env.VERCEL === "1" ? req.geo : LOCALHOST_GEO_DATA;
  const ua = userAgent(req);
  const referer = req.headers.get("referer");
  const identity_hash = await getIdentityHash(req);
  // if in production / preview env, deduplicate clicks from the same IP & link ID – only record 1 click per hour
  if (process.env.VERCEL === "1") {
    const { success } = await ratelimit(2, "1 h").limit(
      `recordClick:${identity_hash}:${id}`,
    );
    if (!success) {
      return null;
    }
  }

  return await Promise.allSettled([
    fetch(
      `${process.env.TINYBIRD_API_URL}/v0/events?name=dub_click_events&wait=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TINYBIRD_API_KEY}`,
        },
        body: JSON.stringify({
          timestamp: new Date(Date.now()).toISOString(),
          identity_hash,
          click_id: clickId || generateClickId(),
          link_id: id,
          alias_link_id: "",
          affiliate_id: affiliateId || "",
          url: url || "",
          country: geo?.country || "Unknown",
          city: geo?.city || "Unknown",
          region: geo?.region || "Unknown",
          latitude: geo?.latitude || "Unknown",
          longitude: geo?.longitude || "Unknown",
          device: ua.device.type ? capitalize(ua.device.type) : "Desktop",
          device_vendor: ua.device.vendor || "Unknown",
          device_model: ua.device.model || "Unknown",
          browser: ua.browser.name || "Unknown",
          browser_version: ua.browser.version || "Unknown",
          engine: ua.engine.name || "Unknown",
          engine_version: ua.engine.version || "Unknown",
          os: ua.os.name || "Unknown",
          os_version: ua.os.version || "Unknown",
          cpu_architecture: ua.cpu?.architecture || "Unknown",
          ua: ua.ua || "Unknown",
          bot: ua.isBot,
          referer: referer
            ? getDomainWithoutWWW(referer) || "(direct)"
            : "(direct)",
          referer_url: referer || "(direct)",
        }),
      },
    ).then((res) => res.json()),

    // increment the click count for the link or domain (based on their ID)
    // also increment the usage count for the project (if it's a link click)
    // and then we have a cron that will reset it at the start of new billing cycle
    root
      ? conn.execute(
          "UPDATE Domain SET clicks = clicks + 1, lastClicked = NOW() WHERE id = ?",
          [id],
        )
      : [
          conn.execute(
            "UPDATE Link SET clicks = clicks + 1, lastClicked = NOW() WHERE id = ?",
            [id],
          ),
          conn.execute(
            "UPDATE Project p JOIN Link l ON p.id = l.projectId SET p.usage = p.usage + 1 WHERE l.id = ?",
            [id],
          ),
        ],
  ]);
}

export async function recordLink({
  link,
  deleted,
}: {
  link: Partial<LinkProps>;
  deleted?: boolean;
}) {
  return await fetch(
    `${process.env.TINYBIRD_API_URL}/v0/events?name=dub_links_metadata&wait=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TINYBIRD_API_KEY}`,
      },
      body: JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        link_id: link.id,
        domain: link.domain,
        key: link.key,
        url: link.url,
        project_id: link.projectId || "",
        deleted: deleted ? 1 : 0,
      }),
    },
  ).then((res) => res.json());
}

export async function recordConversion({
  eventName,
  properties,
  clickId,
  affiliateId,
}: {
  eventName: string;
  properties: Record<string, any>;
  clickId: string;
  affiliateId?: string;
}) {
  return await fetch(
    `${process.env.TINYBIRD_API_URL}/v0/events?name=dub_conversion_events&wait=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TINYBIRD_API_KEY}`,
      },
      body: JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        click_id: clickId,
        affiliate_id: affiliateId || "",
        event_name: eventName,
        properties: properties,
      }),
    },
  ).then((res) => res.json());
}
