# SproutOS

SproutOS enables users to cost-effectively create and deploy database-backed workflows
and backend-supported, auth-backed sites without knowing how to code.

## Features

### App Store

We host an app store of open source apps and workflows. At the moment, this includes
an Android play store and a website store. Users can customize open source apps for
personalization needs, and our infrastructure will keep users' forks up-to-date, folding
upstream fixes and features into the personalized codebase.

We want to democratize creating personalized apps and workflows. An open app store
enables this by making the large hurdle of creating the initial app already done
through our ecosystem and personalization is only a sentence in a coding agent away.

Fork maintenance can use your existing Claude Code subscription or an API key
to a service including in-house LLM hosts.

### Serverless Backend Operations

We host serverless backend operations including:

- Serverless sites: we recreated Vercel Fluid Compute, hosting websites for a few cents per month
- Workflows: cron and on-demand based workflows and background jobs spun up only when used.
  We use Firecracker to execute your custom code, and use a managed service to intelligently
  deduce when and for how long to have your workflow code running.
- Databases: serverless Postgres allows us to bill few cents per month with fast cold starts.
- Tenant-split databases: We host a shared Valkey and Elasticsearch service that is tenant-split
- Discounted AI token prices: through our service, we can reduce your AI token cost through
  our service-wide purchasing of API tokens from LLM providers

Because users can spin up databases cheaply, this means an app that values users' privacy and
data ownership can use OAuth Login to SproutOS and create a database dedicated to the user,
allowing data ownership without needing a fork. Data ownership and personalization
are core tenants of SproutOS. A user doesn't need to fork to own their data either
if the original app enables personalized databases.

Data ownership enables users to use coding agents to transfer their data to other
apps in a similar vertical; data ownership reduces switching costs and can help flourish
diversity in app ecosystems.

### Sites and Workflows

We also host sites, like Lovable and OpenAI Sites, and workflows, like n8n. The difference is
we ensure code is open source and our infrastructure does not lock you in. For privacy,
personalization, and data ownership focused consumers, you'll love our fork maintenance and app
stores.

Sprout sites are also useful for setting up RAG pipelines. For example, iMessage has a horrible
search result reputation. Sprout's community coding agent skills learned from top Silicon Valley startups
how to set up customized, refined, and fine tuned RAG that utilize more than just the basic
embedding models and embedding databases. With those skills, Sprout can create a website for
searching messages and set up the necessary backend services for cheap and provide better results.

### For Businesses

For businesses and AI consultancies, our service allows employees to conveniently create automations
with just a few sentences. For example, customer success managers are overworked and wish they
could program custom follow-up messages to clients or cancel if they followed up already. For different
departments, SproutOS Sites enable employees of different departments to create their own RAG pipelines.
Users would simply need to connect with Sprout/Claude's coding agent, integrate with their chosen
data source, tell the coding agent what their expected search queries and results should look like,
and utilize Sprout's skills to create a custom RAG pipeline for one's use case. Skills go beyond
embeddings, using fine tuned embeddings and coding agent skills from our community that can build
out multiple backend services like a knowledge graph and refine what data to ingest. See this
[ByteByteGo article for different examples of use case based RAG pipelines](https://blog.bytebytego.com/p/why-doordash-instacart-and-uber-eats).

We remove the need for businesses to provide technical resources to deploy their ideal automations
and websites. Sprout's backend operation solutions reduce bureaucracy by empowering employees to
deploy whatever software they need for super cheap.

---

Scaffolded from [Andrew-Chen-Wang/nextjs-spa-split](https://github.com/Andrew-Chen-Wang/nextjs-spa-split).
Licensed BSD 3-Clause — see `LICENSE`.
