import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const siteUrl = (process.env.SITE_URL || "https://breakpointtalent.com").replace(/\/$/, "");
const jobsApiUrl = process.env.JOBS_API_URL || "https://ace.breakpointtalent.com/api/public/jobs";

const timeZoneByState = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DC: "America/New_York", DE: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  IA: "America/Chicago", ID: "America/Boise", IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", MA: "America/New_York", MD: "America/New_York",
  ME: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MO: "America/Chicago", MS: "America/Chicago", MT: "America/Denver",
  NC: "America/New_York", ND: "America/Chicago", NE: "America/Chicago",
  NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NV: "America/Los_Angeles", NY: "America/New_York", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VA: "America/New_York", VT: "America/New_York", WA: "America/Los_Angeles",
  WI: "America/Chicago", WV: "America/New_York", WY: "America/Denver",
  PR: "America/Puerto_Rico", VI: "America/St_Thomas",
};

const staticEntries = [
  "index.html",
  "jobs.css",
  "onboarding",
  "smsprivacy",
  "terms",
  "bp-apple-touch-icon.png",
  "bp-favicon-16x16.png",
  "bp-favicon-192x192.png",
  "bp-favicon-32x32.png",
  "bp-favicon-512x512.png",
  "favicon.ico",
  "icon-email.png",
  "icon-globe.png",
  "icon-location.png",
  "icon-phone.png",
  "logo-icon.png",
  "logo.png",
];

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeXml(value = "") {
  return escapeHtml(value).replace(/&#039;/g, "&apos;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function plainText(value = "") {
  return String(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/[#>*_`\[\]()~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionBody(markdown = "", heading) {
  const lines = String(markdown).split("\n");
  const target = heading.trim().toLowerCase();
  const body = [];
  let collecting = false;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (collecting) break;
      collecting = match[1].trim().toLowerCase() === target;
      continue;
    }
    if (collecting) body.push(line);
  }
  return body.join("\n").trim();
}

function truncate(value, max = 220) {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max + 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > max * .65 ? boundary : max).trim()}…`;
}

function jobSummary(job) {
  const about = sectionBody(job.description, "A Bit About Us");
  const firstParagraph = about.split(/\n\s*\n/).find((part) => plainText(part));
  return truncate(plainText(firstParagraph || job.description), 230);
}

function jobHighlights(job) {
  const preferred = sectionBody(job.description, "Why Join Us");
  const source = preferred || job.description || "";
  return source
    .split("\n")
    .map((line) => line.match(/^\s*[-*+]\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map((line) => truncate(plainText(line), 105))
    .slice(0, 3);
}

function workplaceLabel(job) {
  if (job.workplaceType) return job.workplaceType;
  const copy = plainText(job.description).toLowerCase();
  if (/\bhybrid\b/.test(copy)) return "Hybrid";
  if (/\bfully remote\b|\b100% remote\b|\bwork remotely\b/.test(copy)) return "Remote";
  return "On-site";
}

function hybridScheduleLabel(job) {
  if (workplaceLabel(job) !== "Hybrid" || !job.hybridSchedule) return null;
  return /\bdays?$/i.test(job.hybridSchedule)
    ? `${job.hybridSchedule} in office`
    : job.hybridSchedule;
}

function markdownHtml(value) {
  if (!value) return "";
  const rendered = marked.parse(value, { async: false, gfm: true, breaks: true });
  return sanitizeHtml(rendered, {
    allowedTags: ["p", "br", "ul", "ol", "li", "h2", "h3", "h4", "strong", "em", "a"],
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });
}

function locationLabel(job) {
  const structured = [job.location?.city, job.location?.state].filter(Boolean).join(", ");
  return structured || job.locations?.[0] || "Location available on request";
}

function googleEmploymentType(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const values = {
    "full time": "FULL_TIME",
    "part time": "PART_TIME",
    contractor: "CONTRACTOR",
    contract: "CONTRACTOR",
    temporary: "TEMPORARY",
    intern: "INTERN",
    internship: "INTERN",
    "per diem": "PER_DIEM",
  };
  return values[normalized] || (normalized ? "OTHER" : undefined);
}

function validThrough(job) {
  const datePosted = String(job.datePosted || "").slice(0, 10);
  const match = datePosted.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;

  const expires = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  expires.setUTCDate(expires.getUTCDate() + 60);
  const year = expires.getUTCFullYear();
  const month = String(expires.getUTCMonth() + 1).padStart(2, "0");
  const day = String(expires.getUTCDate()).padStart(2, "0");
  const timeZone = timeZoneByState[String(job.location?.state || "").toUpperCase()]
    || "America/New_York";
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(Date.UTC(year, expires.getUTCMonth(), expires.getUTCDate(), 12)))
    .find((part) => part.type === "timeZoneName")?.value;
  const offset = offsetPart?.replace("GMT", "") || "-05:00";
  return `${year}-${month}-${day}T23:59:59${offset}`;
}

function salaryLabel(salary) {
  const min = salary?.minimum;
  const max = salary?.maximum;
  if (min == null && max == null) return null;
  const formatter = (amount) => {
    if (amount == null) return null;
    if (salary?.frequency === "yearly" && amount >= 1000) {
      return `$${Math.round(amount / 1000)}k`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: salary?.currency || "USD",
      maximumFractionDigits: 0,
    }).format(amount);
  };
  const range = min != null && max != null
    ? `${formatter(min)}–${formatter(max)}`
    : min != null
      ? `From ${formatter(min)}`
      : `Up to ${formatter(max)}`;
  return `${range}${salary?.frequency === "hourly" ? " / hour" : " / year"}`;
}

function salarySchema(salary) {
  if (!salary?.currency || (salary.minimum == null && salary.maximum == null)) return undefined;
  const value = { "@type": "QuantitativeValue", unitText: salary.frequency === "hourly" ? "HOUR" : "YEAR" };
  if (salary.minimum != null) value.minValue = salary.minimum;
  if (salary.maximum != null) value.maxValue = salary.maximum;
  return { "@type": "MonetaryAmount", currency: salary.currency, value };
}

function head({ title, description, canonical, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="/bp-apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/jobs.css">
  ${jsonLd ? `<script type="application/ld+json">${safeJson(jsonLd)}</script>` : ""}
</head>`;
}

function nav() {
  return `<nav class="site-nav" aria-label="Main navigation">
  <a href="/" class="nav-logo" aria-label="BreakPoint Talent home">
    <svg class="nav-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true"><circle cx="40" cy="32" r="19" fill="#2A2A2A"/><ellipse cx="38" cy="70" rx="24" ry="17" fill="#2A2A2A"/><circle cx="63" cy="37" r="15" fill="#5A9642"/><ellipse cx="62" cy="72" rx="20" ry="15" fill="#5A9642"/></svg>
    <span class="nav-wordmark"><strong>BreakPoint</strong><span>Talent</span></span>
  </a>
  <ul class="nav-links">
    <li><a href="/#about">About</a></li>
    <li><a href="/#industries">Expertise</a></li>
    <li><a href="/jobs/" aria-current="page">Open Roles</a></li>
    <li><a href="/#contact" class="nav-cta">Contact Us</a></li>
  </ul>
</nav>`;
}

function footer() {
  return `<footer class="site-footer">
  <span>© ${new Date().getFullYear()} BreakPoint Talent</span>
  <ul class="footer-links"><li><a href="/jobs/">Open Roles</a></li><li><a href="/terms/">Terms</a></li><li><a href="/smsprivacy/">Privacy</a></li></ul>
</footer>`;
}

function renderJobsIndex(jobs) {
  const cards = jobs.map((job) => {
    const location = locationLabel(job);
    const salary = salaryLabel(job.salary);
    const workplace = workplaceLabel(job);
    const hybridSchedule = hybridScheduleLabel(job);
    const summary = jobSummary(job);
    const highlights = jobHighlights(job);
    const search = [job.title, location, job.employmentType, workplace, hybridSchedule, salary, summary, ...highlights].filter(Boolean).join(" ").toLowerCase();
    return `<a class="job-card" href="/jobs/${escapeHtml(job.slug)}/" data-job-card data-search="${escapeHtml(search)}">
      <div class="job-card-main">
        <p class="card-eyebrow">Open opportunity</p>
        <h2>${escapeHtml(job.title)}</h2>
        <div class="job-meta">
          <span class="meta-pill">${escapeHtml(location)}</span>
          <span class="meta-pill">${escapeHtml(workplace)}</span>
          ${hybridSchedule ? `<span class="meta-pill">${escapeHtml(hybridSchedule)}</span>` : ""}
          ${job.employmentType ? `<span class="meta-pill">${escapeHtml(job.employmentType)}</span>` : ""}
          ${salary ? `<span class="meta-pill">${escapeHtml(salary)}</span>` : ""}
        </div>
        ${summary ? `<p class="job-summary">${escapeHtml(summary)}</p>` : ""}
        <span class="view-role">View role <span aria-hidden="true">→</span></span>
      </div>
      ${highlights.length ? `<div class="job-highlights"><p>Why this role stands out</p><ul>${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    </a>`;
  }).join("\n");
  const description = "Explore current opportunities represented by BreakPoint Talent and apply directly online.";
  return `${head({ title: "Open Roles | BreakPoint Talent", description, canonical: `${siteUrl}/jobs/` })}
<body>${nav()}
<header class="page-hero"><div class="hero-inner"><p class="eyebrow">Current Opportunities</p><h1>Find Your Next <em style="color:#5A9642">BreakPoint.</em></h1><p class="hero-copy">Explore roles we’re actively recruiting for. Every application is reviewed by a real recruiter, and every conversation is confidential.</p></div></header>
<main class="content-wrap">
  <div class="search-wrap"><label for="job-search">Search open roles</label><input id="job-search" type="search" placeholder="Search by title, location, or employment type…" autocomplete="off"></div>
  <div class="jobs-grid" id="jobs-grid">${cards}</div>
  <div class="empty-state" id="empty-state"${jobs.length ? " hidden" : ""}>${jobs.length ? "No open roles match that search." : "No roles are published right now. Check back soon or contact BreakPoint Talent about your next move."}</div>
</main>
${footer()}
<script>
const input=document.getElementById('job-search');const cards=[...document.querySelectorAll('[data-job-card]')];const empty=document.getElementById('empty-state');input.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();let shown=0;for(const card of cards){const match=!q||card.dataset.search.includes(q);card.hidden=!match;if(match)shown++;}empty.hidden=shown!==0;});
</script>
</body></html>`;
}

function renderJobPage(job) {
  const canonical = `${siteUrl}/jobs/${job.slug}/`;
  const location = locationLabel(job);
  const salary = salaryLabel(job.salary);
  const workplace = workplaceLabel(job);
  const hybridSchedule = hybridScheduleLabel(job);
  const descriptionHtml = markdownHtml(job.description);
  const metaDescription = job.description
    ? `${plainText(job.description).slice(0, 135)}${plainText(job.description).length > 135 ? "…" : ""}`
    : `Learn more and apply for the ${job.title} opportunity in ${location} through BreakPoint Talent.`;
  const employmentType = googleEmploymentType(job.employmentType);
  const jsonLd = job.eligibleForJobPosting ? {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: descriptionHtml,
    identifier: { "@type": "PropertyValue", name: "BreakPoint Talent", value: job.id },
    datePosted: job.datePosted.slice(0, 10),
    validThrough: validThrough(job),
    directApply: true,
    hiringOrganization: {
      "@type": "Organization",
      name: "BreakPoint Talent",
      legalName: "Kraig Talent LLC",
      sameAs: siteUrl,
      logo: `${siteUrl}/bp-favicon-512x512.png`,
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location.city,
        addressRegion: job.location.state,
        postalCode: job.location.postalCode || undefined,
        addressCountry: job.location.country || "US",
      },
    },
    employmentType,
    baseSalary: salarySchema(job.salary),
    url: canonical,
  } : null;
  if (jsonLd && job.workplaceType === "Remote") {
    jsonLd.jobLocationType = "TELECOMMUTE";
    jsonLd.applicantLocationRequirements = { "@type": "Country", name: "USA" };
  }
  if (jsonLd) {
    for (const key of Object.keys(jsonLd)) if (jsonLd[key] === undefined) delete jsonLd[key];
    if (jsonLd.jobLocation?.address) {
      for (const key of Object.keys(jsonLd.jobLocation.address)) {
        if (jsonLd.jobLocation.address[key] === undefined) delete jsonLd.jobLocation.address[key];
      }
    }
  }
  return `${head({ title: `${job.title} in ${location} | BreakPoint Talent`, description: metaDescription, canonical, jsonLd })}
<body>${nav()}
<header class="page-hero detail-hero"><div class="hero-inner"><a class="breadcrumb" href="/jobs/">← All open roles</a><h1>${escapeHtml(job.title)}</h1><div class="detail-meta"><span class="meta-pill">${escapeHtml(location)}</span><span class="meta-pill">${escapeHtml(workplace)}</span>${hybridSchedule ? `<span class="meta-pill">${escapeHtml(hybridSchedule)}</span>` : ""}${job.employmentType ? `<span class="meta-pill">${escapeHtml(job.employmentType)}</span>` : ""}${salary ? `<span class="meta-pill">${escapeHtml(salary)}</span>` : ""}</div><button class="share-job-button" id="share-job" type="button" aria-label="Share this job"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"></path></svg><span>Share this job</span></button></div></header>
<main class="content-wrap detail-grid">
  <article class="job-description">
    ${descriptionHtml || `<h2>About this opportunity</h2><p>Contact BreakPoint Talent for full role details. This active search is not yet eligible for Google’s enhanced job results because its complete job description has not been added in Ace.</p>`}
  </article>
  <aside class="apply-panel" id="apply">
    <h2>Apply for this role</h2><p>Send your information directly to BreakPoint Talent. We’ll review it confidentially and follow up if the opportunity is a match.</p>
    ${job.applyUrl ? `<a class="primary-button external-apply" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noopener noreferrer">Apply on job site</a>` : ""}
    <form name="job-application" method="POST" action="/jobs/thanks/" data-netlify="true" netlify-honeypot="bot-field" enctype="multipart/form-data">
      <input type="hidden" name="form-name" value="job-application">
      <input type="hidden" name="job-id" value="${escapeHtml(job.id)}">
      <input type="hidden" name="job-title" value="${escapeHtml(job.title)}">
      <input type="hidden" name="job-url" value="${escapeHtml(canonical)}">
      <p class="visually-hidden"><label>Don’t fill this out: <input name="bot-field"></label></p>
      <div class="form-field"><label for="name-${escapeHtml(job.id)}">Name</label><input id="name-${escapeHtml(job.id)}" name="name" type="text" autocomplete="name" required></div>
      <div class="form-field"><label for="email-${escapeHtml(job.id)}">Email</label><input id="email-${escapeHtml(job.id)}" name="email" type="email" autocomplete="email" required></div>
      <div class="form-field"><label for="phone-${escapeHtml(job.id)}">Phone</label><input id="phone-${escapeHtml(job.id)}" name="phone" type="tel" autocomplete="tel"></div>
      <div class="form-field"><label for="resume-${escapeHtml(job.id)}">Resume</label><input id="resume-${escapeHtml(job.id)}" name="resume" type="file" accept=".pdf,.doc,.docx" required></div>
      <div class="form-field"><label for="message-${escapeHtml(job.id)}">Message</label><textarea id="message-${escapeHtml(job.id)}" name="message" placeholder="Anything you’d like us to know?"></textarea></div>
      <button class="apply-button" type="submit">Submit application</button>
      <p class="form-note">By submitting, you agree that BreakPoint Talent may contact you about this opportunity.</p>
    </form>
  </aside>
</main>${footer()}
<script>
const shareButton=document.getElementById('share-job');
shareButton?.addEventListener('click',async()=>{
  const label=shareButton.querySelector('span');
  const data={title:${safeJson(job.title)},text:${safeJson(`Take a look at this ${job.title} opportunity from BreakPoint Talent.`)},url:window.location.href};
  try{
    if(navigator.share){await navigator.share(data);return;}
    if(navigator.clipboard){await navigator.clipboard.writeText(data.url);label.textContent='Link copied';setTimeout(()=>label.textContent='Share this job',1800);return;}
    window.prompt('Copy this job link:',data.url);
  }catch(error){if(error?.name!=='AbortError')window.prompt('Copy this job link:',data.url);}
});
</script>
</body></html>`;
}

function renderThanksPage() {
  return `${head({ title: "Application Received | BreakPoint Talent", description: "Your application has been received by BreakPoint Talent.", canonical: `${siteUrl}/jobs/thanks/` })}<body>${nav()}<main class="content-wrap"><section class="center-card"><p class="eyebrow" style="justify-content:center">Application Received</p><h1>Thank You.</h1><p>Your information is on its way to BreakPoint Talent. We’ll review it and reach out if the opportunity looks like a fit.</p><a class="primary-button" style="width:auto" href="/jobs/">View open roles</a></section></main>${footer()}</body></html>`;
}

async function loadFeed() {
  if (process.env.JOBS_FEED_FILE) {
    return JSON.parse(await readFile(path.resolve(root, process.env.JOBS_FEED_FILE), "utf8"));
  }
  const separator = jobsApiUrl.includes("?") ? "&" : "?";
  const response = await fetch(`${jobsApiUrl}${separator}build=${Date.now()}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Jobs API returned ${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  const feed = await loadFeed();
  if (!feed?.ok || !Array.isArray(feed.jobs)) throw new Error("Jobs API returned an invalid feed.");
  const slugs = new Set();
  for (const job of feed.jobs) {
    if (!job.id || !job.slug || !job.title) throw new Error("Jobs feed contains an incomplete record.");
    if (slugs.has(job.slug)) throw new Error(`Duplicate public job slug: ${job.slug}`);
    slugs.add(job.slug);
  }

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const entry of staticEntries) await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });

  const jobsDir = path.join(dist, "jobs");
  await mkdir(jobsDir, { recursive: true });
  await writeFile(path.join(jobsDir, "index.html"), renderJobsIndex(feed.jobs));
  for (const job of feed.jobs) {
    const dir = path.join(jobsDir, job.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), renderJobPage(job));
  }
  await mkdir(path.join(jobsDir, "thanks"), { recursive: true });
  await writeFile(path.join(jobsDir, "thanks", "index.html"), renderThanksPage());

  const sitemapEntries = [
    { url: `${siteUrl}/`, lastmod: new Date().toISOString() },
    { url: `${siteUrl}/jobs/`, lastmod: feed.generatedAt || new Date().toISOString() },
    ...feed.jobs.map((job) => ({ url: `${siteUrl}/jobs/${job.slug}/`, lastmod: job.updatedAt })),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.map(({ url, lastmod }) => `  <url><loc>${escapeXml(url)}</loc><lastmod>${escapeXml(lastmod)}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  await writeFile(path.join(dist, "sitemap.xml"), sitemap);
  await writeFile(path.join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

  console.log(`Built BreakPoint Talent with ${feed.jobs.length} open job pages.`);
}

await main();
