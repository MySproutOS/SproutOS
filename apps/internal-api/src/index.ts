import { Scalar } from "@scalar/hono-api-reference"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { generateSpecs, type OpenApiSpecsOptions, openAPISpecs } from "hono-typebox-openapi"
import { apexDomain } from "./utils/env"
import { ErrorObjectT, ErrorResponseT, InnerErrorT } from "./utils/errors/error.serializer"
import v1 from "./v1"
import admin from "./admin"

const spec: OpenApiSpecsOptions = {
  documentation: {
    info: {
      title: "Internal API",
      version: "1.0.0",
      description: "Internal API",
    },
    servers: [
      {
        url: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
        description: "Local Server",
      },
    ],
    components: {
      schemas: {
        InnerErrorT,
        ErrorObjectT,
        ErrorResponseT,
      },
    },
  },
}

const app = new Hono()

// The API is its own deployment on api.<domain>, so every browser call is cross-origin.
// Same-site (shared registrable domain) is what keeps the SameSite=lax session cookie flowing;
// CORS is what makes the XHR itself legal.
app.use(
  cors({
    origin: (origin) => {
      if (!origin) return null

      const { hostname } = new URL(origin)

      // Only outside production: a credentialed allowlist entry for localhost would otherwise
      // let any page a developer-tools user visits locally call the live API as them.
      if (
        process.env.NODE_ENV !== "production" &&
        (hostname === "localhost" || hostname === "127.0.0.1")
      ) {
        return origin
      }

      const apex = apexDomain()
      if (apex !== undefined && (hostname === apex || hostname.endsWith(`.${apex}`))) {
        return origin
      }

      return null
    },
    credentials: true,
  }),
)

if (process.env.NODE_ENV === "development") {
  app.get(
    "/openapi",
    openAPISpecs(app, {
      ...spec,
      exclude: /^\/admin(?:\/|$).*/,
    }),
  )
  app.get(
    "/admin-openapi",
    openAPISpecs(app, {
      ...spec,
      exclude: /^(?!\/admin(?:\/|$)).*/,
    }),
  )
  app.get(
    "/docs",
    Scalar(() => {
      return {
        url: "/openapi",
        theme: "saturn",
      }
    }),
  )
  app.get(
    "/admin-docs",
    Scalar(() => {
      return {
        url: "/admin-openapi",
        theme: "saturn",
      }
    }),
  )
}

const routes = app.route("", v1).route("", admin)

export default app
export type AppType = typeof routes

if (process.argv.includes("--openapi")) {
  generateSpecs(app, spec)
    .then((specs) => {
      console.log(JSON.stringify(specs, null, 2))
    })
    .catch(console.error)
}
