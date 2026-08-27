import cf from "cloudfront"

const routes = cf.kvs()

async function handler(event) {
  const request = event.request
  const hostHeader = request.headers.host
  if (!hostHeader || !hostHeader.value) {
    return { statusCode: 400, statusDescription: "Bad Request" }
  }

  const hostname = hostHeader.value.toLowerCase().split(":", 1)[0]
  let prefix
  try {
    prefix = await routes.get(hostname)
  } catch {
    return { statusCode: 404, statusDescription: "No static deployment for this hostname" }
  }

  let uri = request.uri || "/"
  const leaf = uri.slice(uri.lastIndexOf("/") + 1)
  if (uri.endsWith("/") || !leaf.includes(".")) uri = "/index.html"
  request.uri = `/sites/${prefix}${uri}`
  return request
}
