// Synthetic responses shaped like each board's live API/feed (field names and
// nesting verified against live responses on 2026-11-09; values are invented).
// Used by the offline tests with a stubbed fetch.

export const remoteOkFeed = [
  {
    last_updated: 1794240020,
    legal: "API Terms of Service: Please link back to the URL on Remote OK and mention Remote OK as a source.",
  },
  {
    slug: "remote-llm-inference-engineer-acme-1000001",
    id: "1000001",
    epoch: 1794000000,
    date: "2026-11-07T10:00:00+00:00",
    company: "Acme AI",
    position: "LLM Inference Engineer",
    tags: ["llm", "python", "vllm"],
    description: "<p>Serve <b>LLMs</b> with vLLM.</p><ul><li>Latency</li><li>Throughput</li></ul>",
    location: "Anywhere in the World",
    salary_min: 60000,
    salary_max: 90000,
    url: "https://remoteOK.com/remote-jobs/remote-llm-inference-engineer-acme-1000001",
    apply_url: "https://remoteOK.com/remote-jobs/remote-llm-inference-engineer-acme-1000001",
  },
  {
    slug: "remote-ml-engineer-beta-1000002",
    id: "1000002",
    date: "2026-11-06T10:00:00+00:00",
    company: "Beta",
    position: "Machine Learning Engineer",
    tags: ["machine learning"],
    description: "<p>US only team.</p>",
    location: "Madrid, Madrid, Comunidad de Madrid, EspaÃ±a",
    salary_min: 0,
    salary_max: 0,
    url: "https://remoteOK.com/remote-jobs/remote-ml-engineer-beta-1000002",
  },
]

export const himalayasSearch = {
  comments: "Search results come 20 to a page.",
  offset: 0,
  limit: 20,
  totalCount: 3,
  jobs: [
    {
      title: "Voice AI Engineer",
      companyName: "Gamma",
      companySlug: "gamma",
      employmentType: "Full Time",
      minSalary: 30000,
      maxSalary: 50000,
      salaryPeriod: "annual",
      currency: "USD",
      seniority: ["Mid-level"],
      locationRestrictions: ["India"],
      timezoneRestrictions: [5.5],
      categories: ["Machine-Learning-Engineer"],
      parentCategories: ["Engineering"],
      description: "<p>Build real-time voice agents.</p>",
      pubDate: 1794100000,
      expiryDate: 1799400000,
      applicationLink: "https://himalayas.app/companies/gamma/jobs/voice-ai-engineer?utm_source=api",
      guid: "https://himalayas.app/companies/gamma/jobs/voice-ai-engineer",
    },
    {
      title: "Senior Machine Learning Engineer",
      companyName: "Delta",
      companySlug: "delta",
      employmentType: "Full Time",
      minSalary: null,
      maxSalary: null,
      currency: "USD",
      seniority: ["Senior"],
      locationRestrictions: ["United States"],
      timezoneRestrictions: [-10, -9, -8, -7, -6, -5, 14],
      categories: [],
      parentCategories: [],
      description: "<p>US role.</p>",
      pubDate: 1794000000,
      applicationLink: "https://himalayas.app/companies/delta/jobs/senior-ml?utm_source=api",
      guid: "https://himalayas.app/companies/delta/jobs/senior-ml",
    },
    {
      // Same company + title as the Remote OK posting: deduped.
      title: "LLM Inference Engineer",
      companyName: "Acme AI",
      companySlug: "acme-ai",
      employmentType: "Full Time",
      locationRestrictions: [],
      timezoneRestrictions: [],
      categories: [],
      parentCategories: [],
      description: "<p>Serve LLMs.</p>",
      pubDate: 1793900000,
      applicationLink: "https://himalayas.app/companies/acme-ai/jobs/llm-inference-engineer?utm_source=api",
      guid: "https://himalayas.app/companies/acme-ai/jobs/llm-inference-engineer",
    },
  ],
}

export const jobicyFeed = {
  apiVersion: "2.2.19",
  friendlyNotice: "Please credit Jobicy and link to the source.",
  jobCount: 2,
  nextCursor: null,
  hasMore: false,
  jobs: [
    {
      id: 200001,
      url: "https://jobicy.com/jobs/200001-rag-engineer",
      jobTitle: "RAG Engineer",
      companyName: "Epsilon",
      jobIndustry: ["Data Science &amp; Analytics"],
      jobType: ["Full-Time"],
      jobGeo: "APAC",
      jobLevel: "Midweight",
      jobDescription: "<p>Retrieval augmented generation.</p>",
      pubDate: "2026-11-08T09:00:00+00:00",
      salaryMin: 40000,
      salaryMax: 60000,
      salaryCurrency: "USD",
      salaryPeriod: "yearly",
    },
    {
      id: 200002,
      url: "https://jobicy.com/jobs/200002-data-scientist",
      jobTitle: "Data Scientist",
      companyName: "Zeta",
      jobIndustry: ["Data Science & Analytics"],
      jobType: ["Full-Time"],
      jobGeo: "USA",
      jobLevel: "Any",
      jobDescription: "<p>Uses LLM tooling.</p>",
      pubDate: "2026-10-01T09:00:00+00:00",
    },
  ],
}

export const wwrRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>We Work Remotely</title>
<item>
  <title>Eta Labs: Senior AI Engineer</title>
  <region>Anywhere in the World</region>
  <country></country>
  <skills>Python, LLM, and RAG</skills>
  <category>Back-End Programming</category>
  <type>Full-Time</type>
  <description>&lt;p&gt;Build &lt;strong&gt;LLM&lt;/strong&gt; apps.&lt;/p&gt;</description>
  <pubDate>Sun, 08 Nov 2026 07:31:05 +0000</pubDate>
  <guid>https://weworkremotely.com/remote-jobs/eta-labs-senior-ai-engineer</guid>
  <link>https://weworkremotely.com/remote-jobs/eta-labs-senior-ai-engineer</link>
</item>
<item>
  <title>Theta: Applied AI Engineer</title>
  <region>Anywhere in the World</region>
  <country>🇧🇷 Brazil, 🇨🇱 Chile, and 🇺🇾 Uruguay</country>
  <category>Programming</category>
  <description>&lt;p&gt;LLM document pipelines.&lt;/p&gt;</description>
  <pubDate>Sat, 07 Nov 2026 07:31:05 +0000</pubDate>
  <guid>https://weworkremotely.com/remote-jobs/theta-applied-ai-engineer</guid>
  <link>https://weworkremotely.com/remote-jobs/theta-applied-ai-engineer</link>
</item>
<item>
  <title>broken item without link
</item>
<item>
  <title>Iota: Hybrid ML Engineer</title>
  <region>Anywhere in the World</region>
  <description>&lt;p&gt;We work onsite three days a week in NYC. LLM work.&lt;/p&gt;</description>
  <pubDate>Fri, 06 Nov 2026 07:31:05 +0000</pubDate>
  <link>https://weworkremotely.com/remote-jobs/iota-hybrid-ml-engineer</link>
</item>
</channel></rss>`

export const workingNomadsFeed = [
  {
    url: "https://www.workingnomads.com/job/go/3000001/",
    title: "Senior LLM Engineer",
    description: "<p>LLM agents.</p>",
    company_name: "Kappa",
    category_name: "Development",
    tags: "llm,python",
    location: "Time zone: CET (+/- 3 hours)",
    pub_date: "2026-11-09T08:52:38-05:00",
  },
  {
    url: "https://www.workingnomads.com/job/go/3000002/",
    title: "LLM Evaluation Engineer",
    description: "<p>Evals for LLM systems.</p>",
    company_name: "Lambda",
    category_name: "Development",
    tags: "llm,evals",
    location: "Europe, LATAM, APAC, the U.S., Canada",
    pub_date: "2026-11-05T08:52:38-05:00",
  },
]

/** A posting page carrying schema.org JobPosting JSON-LD with raw newlines in a string (as WWR serves it). */
export const jobPostingPage = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList"}</script>
<script type="application/ld+json">{
  "@context" : "http://schema.org/",
  "@type" : "JobPosting",
  "title" : "RAG Engineer",
  "description" : "&lt;p&gt;Retrieval work.&lt;/p&gt;
&lt;ul&gt;&lt;li&gt;Embeddings&lt;/li&gt;&lt;/ul&gt;",
  "datePosted" : "2026-11-08T09:00:00+00:00",
  "validThrough" : "2099-12-01T00:00:00+00:00",
  "employmentType" : "FULL_TIME",
  "hiringOrganization" : {"@type":"Organization","name":"Epsilon"},
  "applicantLocationRequirements" : [{"@type":"Country","name":"India"},{"@type":"Country","name":"Singapore"}],
  "baseSalary" : {"@type":"MonetaryAmount","currency":"USD","value":{"@type":"QuantitativeValue","minValue":40000,"maxValue":60000,"unitText":"YEAR"}}
}</script></head><body><h1>RAG Engineer</h1></body></html>`
