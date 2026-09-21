/**
 * PPR-003 — the DOM-level structural assertion helpers.
 *
 * The viewport/device plan and the accessibility dimensions are
 * asserted STRUCTURALLY over the SERVED HTML (the repository's own
 * responsive and a11y conventions) — landmarks, nav presence,
 * active-item semantics, focus order affordances and the served CSS's
 * responsive/motion rules. Assertions are deliberately INDEPENDENT of
 * exact layout choices so the harness survives the console's PPR-001
 * reorganization: they pin the STRUCTURAL contract (skip link, nav
 * anchors, aria-current, viewport meta, the media-query plan,
 * prefers-reduced-motion), never the arrangement.
 */

/** True when the served page declares the responsive viewport. */
export function hasViewportMeta(html: string): boolean {
  return /<meta\s+name="viewport"\s+content="width=device-width/i.test(html);
}

/** True when a skip-to-content link is the page's keyboard escape hatch. */
export function hasSkipLink(html: string): boolean {
  return /class="[^"]*skip-link[^"]*"/i.test(html) || /skip to (main|content)/i.test(html);
}

/** True when the page carries a <main> landmark. */
export function hasMainLandmark(html: string): boolean {
  return /<main[\s>]/i.test(html);
}

/** True when a primary navigation landmark is present. */
export function hasPrimaryNav(html: string): boolean {
  return /<nav[^>]*aria-label="Primary"/i.test(html) || /<nav[\s>]/i.test(html);
}

/** True when active navigation semantics (aria-current="page") appear. */
export function hasActiveNavSemantics(html: string): boolean {
  return /aria-current="page"/i.test(html);
}

/** True when served content includes a labeled search/command affordance. */
export function hasSearchLandmark(html: string): boolean {
  return /role="search"/i.test(html);
}

/** The responsive plan derived from the served CSS (inline or linked). */
export interface ResponsivePlan {
  readonly mobile: boolean;
  readonly tabletOrDesktop: boolean;
  readonly reducedMotion: boolean;
}

/**
 * Derive the responsive plan markers from the served CSS. The
 * repository's own conventions: a mobile breakpoint (max-width ≈
 * 640px), a tablet/desktop breakpoint (max-width ≈ 1024px or
 * min-width ≈ 1025px) and the prefers-reduced-motion rule.
 */
export function responsivePlanOf(html: string): ResponsivePlan {
  return {
    mobile: /@media[^{]*\(max-width:\s*(64[0-9]|[0-5]?[0-9]{1,2})px\)/i.test(html),
    tabletOrDesktop:
      /@media[^{]*\((max-width:\s*10(2[4-9]|[3-9][0-9]{2})px|min-width:\s*10(2[5-9]|[3-9][0-9]{2})px)\)/i.test(
        html,
      ),
    reducedMotion: /@media[^{]*prefers-reduced-motion/i.test(html),
  };
}

/** Extract same-origin absolute hrefs of internal links (navigation graph). */
export function internalLinksOf(html: string, baseUrl: string): readonly string[] {
  const links = new Set<string>();
  let origin = "";
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }
  for (const match of html.matchAll(/<a\b[^>]*href="([^"#]+)"/gi)) {
    const href = match[1];
    if (href === undefined || href.startsWith("http://") || href.startsWith("https://")) {
      if (href?.startsWith(origin)) {
        links.add(href);
      }
      continue;
    }
    if (href?.startsWith("/")) {
      links.add(`${origin}${href}`);
    }
  }
  return [...links];
}

/** Extract resource URLs a page references (scripts, styles, images). */
export function resourceUrlsOf(html: string, baseUrl: string): readonly string[] {
  const resources = new Set<string>();
  const push = (raw: string): void => {
    if (raw.startsWith("/")) {
      try {
        resources.add(new URL(raw, baseUrl).toString());
      } catch {
        /* unrepresentable resource target — skipped */
      }
    }
  };
  for (const match of html.matchAll(/<script\b[^>]*src="([^"]+)"/gi)) {
    if (match[1] !== undefined) {
      push(match[1]);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*href="([^"]+\.css[^"]*)"/gi)) {
    if (match[1] !== undefined) {
      push(match[1]);
    }
  }
  for (const match of html.matchAll(/<img\b[^>]*src="([^"]+)"/gi)) {
    if (match[1] !== undefined) {
      push(match[1]);
    }
  }
  return [...resources];
}

/** The page's <title> text (a structural identity of the surface). */
export function titleOf(html: string): string {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? "";
}

/**
 * The honest availability-state vocabulary every capability surface
 * must carry (the program plan's mandated states — PPR-001's own
 * required vocabulary: Available / Provider-gated / Requires access /
 * NOT RUN, plus the manifest's classification words).
 */
export const AVAILABILITY_VOCABULARY: readonly string[] = Object.freeze([
  "available",
  "runnable",
  "provider-gated",
  "requires access",
  "not run",
]);

/** True when a served capability page discloses an availability state. */
export function carriesAvailabilityDisclosure(html: string): boolean {
  const lowered = html.toLowerCase();
  return AVAILABILITY_VOCABULARY.some((word) => lowered.includes(word));
}

/** The console composition marker: a served page is an HTML experience surface. */
export function isHtmlSurface(contentType: string | null, body: string): boolean {
  return (
    contentType?.toLowerCase().includes("text/html") === true && body.trimStart().startsWith("<")
  );
}
