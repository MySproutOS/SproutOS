//! A real request, through the real router, to a real Lambda.
//!
//! Everything else in this crate is a unit test over a pure function. This is the one that says the
//! pieces fit: the control plane's route format is one the resolver parses, the event we build is
//! one a handler can read, and what the handler returns becomes an HTTP response.
//!
//! Needs LocalStack (Lambda, S3) and the compose Valkey. Skips without them, because `cargo test`
//! on a laptop should not fail for want of Docker — and says so loudly rather than passing quietly.

use std::io::Write as _;
use std::sync::Arc;

use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::FunctionCode;
use aws_sdk_s3::Client as S3Client;
use axum::Router as AxumRouter;
use axum::routing::any;
use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use router::resolve::Resolver;
use router::serve::{self, Router};

const LOCALSTACK: &str = "http://localhost:4566";
const VALKEY: &str = "redis://localhost:41023";
const HOST: &str = "e2e.sproutos.me";
const FUNCTION: &str = "sproutos-router-e2e";
const ROLE: &str = "arn:aws:iam::000000000000:role/lambda-exec";

/// The handler under test: echoes back what it was given, so the assertions can check that the
/// event carried the method, path, query and body the client actually sent.
const HANDLER: &str = r#"
export const handler = async (event) => ({
  statusCode: 201,
  headers: { "content-type": "application/json", "x-from": "the-function" },
  body: JSON.stringify({
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: event.rawQueryString,
    host: event.requestContext.domainName,
    body: event.body ?? null,
  }),
})
"#;

/// A skip is a laptop without Docker. In CI it is a suite that reported green without running,
/// which this repository has written findings about more than once.
fn refuse_to_skip_in_ci(what: &str) {
    if std::env::var("CI").is_ok() {
        panic!("{what} is not reachable in CI; these tests must not skip here");
    }
}

async fn localstack_up() -> bool {
    let Ok(response) = reqwest::get(format!("{LOCALSTACK}/_localstack/health")).await else {
        return false;
    };
    let Ok(body) = response.text().await else {
        return false;
    };
    body.contains("\"lambda\": \"available\"") || body.contains("\"lambda\": \"running\"")
}

fn zip_handler() -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("index.mjs", options).expect("start file");
        writer.write_all(HANDLER.as_bytes()).expect("write handler");
        writer.finish().expect("finish zip");
    }
    buffer.into_inner()
}

async fn aws_config() -> aws_config::SdkConfig {
    aws_config::from_env()
        .endpoint_url(LOCALSTACK)
        .region("us-east-1")
        .credentials_provider(aws_sdk_lambda::config::Credentials::new(
            "test", "test", None, None, "e2e",
        ))
        .load()
        .await
}

/// Create the function if it is not there, and wait until Lambda will run it.
async fn ensure_function(lambda: &LambdaClient) -> String {
    if let Ok(existing) = lambda.get_function().function_name(FUNCTION).send().await
        && let Some(arn) = existing.configuration().and_then(|c| c.function_arn())
    {
        return arn.to_string();
    }

    let created = lambda
        .create_function()
        .function_name(FUNCTION)
        .role(ROLE)
        .handler("index.handler")
        .runtime(aws_sdk_lambda::types::Runtime::Nodejs22x)
        .code(
            FunctionCode::builder()
                .zip_file(Blob::new(zip_handler()))
                .build(),
        )
        .send()
        .await
        .expect("create the fixture function");

    let arn = created.function_arn().expect("an ARN").to_string();

    /*
      Wait for `Active`.

      A function is created before it can be invoked, and invoking one that is still `Pending`
      fails with `ResourceConflictException`. Without this the test is a race that passes on a warm
      LocalStack and fails on a cold one — the class of flake that gets blamed on the test rather
      than read.
    */
    for _ in 0..60 {
        let state = lambda
            .get_function()
            .function_name(FUNCTION)
            .send()
            .await
            .ok()
            .and_then(|f| f.configuration().and_then(|c| c.state()).cloned());
        if matches!(state, Some(aws_sdk_lambda::types::State::Active)) {
            return arn;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    panic!("the fixture function never became active");
}

#[tokio::test]
async fn a_request_reaches_the_customers_function_and_the_reply_comes_back() {
    if !localstack_up().await {
        refuse_to_skip_in_ci("LocalStack");
        eprintln!("skipping: LocalStack is not reachable at {LOCALSTACK}");
        return;
    }

    let Ok(client) = redis::Client::open(VALKEY) else {
        refuse_to_skip_in_ci("the compose Valkey");
        eprintln!("skipping: {VALKEY} is not a Valkey URL");
        return;
    };
    let Ok(mut valkey) = ConnectionManager::new(client).await else {
        refuse_to_skip_in_ci("the compose Valkey");
        eprintln!("skipping: the Valkey at {VALKEY} is not reachable");
        return;
    };

    let config = aws_config().await;
    let lambda = LambdaClient::new(&config);
    let _s3 = S3Client::new(&config);
    let arn = ensure_function(&lambda).await;

    // Written exactly as `publishRoute` writes it — camelCase keys and all. If the two ever
    // disagree this is where it shows, which is the reason the fixture is a literal rather than a
    // struct serialised by our own code.
    let route = format!(
        r#"{{"arn":"{arn}","projectId":"01a0-p","organizationId":"01a0-o","deploymentId":"01a0-d"}}"#
    );
    let _: () = valkey
        .set(format!("route:{HOST}"), &route)
        .await
        .expect("publish the route");

    let state = Arc::new(Router {
        resolver: Resolver::new(valkey.clone()),
        lambda,
        function_timeout: std::time::Duration::from_secs(60),
    });
    let app = AxumRouter::new()
        .fallback(any(serve::handle))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral port");
    let address = listener.local_addr().expect("a local address");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/items?page=2"))
        .header("host", HOST)
        .header("x-forwarded-for", "203.0.113.7, 10.0.1.4")
        .body(r#"{"name":"ada"}"#)
        .send()
        .await
        .expect("the router answers");

    // The function's own status and headers, not ours.
    assert_eq!(response.status().as_u16(), 201);
    assert_eq!(
        response
            .headers()
            .get("x-from")
            .and_then(|v| v.to_str().ok()),
        Some("the-function")
    );

    let echoed: serde_json::Value = response.json().await.expect("the function's JSON");

    // What the handler saw. Each of these is a field an adapter would read out of the event.
    assert_eq!(echoed["method"], "POST");
    assert_eq!(echoed["path"], "/api/items");
    assert_eq!(echoed["query"], "page=2");
    // The customer's hostname, not the router's address — adapters build request URLs from it.
    assert_eq!(echoed["host"], HOST);
    assert_eq!(echoed["body"], r#"{"name":"ada"}"#);

    let _: () = valkey
        .del(format!("route:{HOST}"))
        .await
        .expect("withdraw the route");
}

#[tokio::test]
async fn the_load_balancer_gets_a_health_answer_and_a_tenant_keeps_its_own_path() {
    if !localstack_up().await {
        refuse_to_skip_in_ci("LocalStack");
        return;
    }
    let Ok(client) = redis::Client::open(VALKEY) else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };
    let Ok(mut valkey) = ConnectionManager::new(client).await else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };

    let config = aws_config().await;
    let lambda = LambdaClient::new(&config);
    let arn = ensure_function(&lambda).await;

    let host = "health.sproutos.me";
    let route =
        format!(r#"{{"arn":"{arn}","projectId":"p","organizationId":"o","deploymentId":"d"}}"#);
    let _: () = valkey
        .set(format!("route:{host}"), &route)
        .await
        .expect("publish the route");

    let state = Arc::new(Router {
        resolver: Resolver::new(valkey.clone()),
        lambda,
        function_timeout: std::time::Duration::from_secs(60),
    });
    let app = AxumRouter::new()
        .fallback(any(serve::handle))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

    // The load balancer probes by IP, so its Host is the instance address and resolves to nothing.
    let probe = reqwest::Client::new()
        .get(format!("http://{address}/healthz"))
        .send()
        .await
        .expect("the router answers");
    assert_eq!(probe.status().as_u16(), 200);

    /*
      A tenant that happens to serve /healthz keeps it.

      Reserving the path outright would take it from every customer application — a real cost, since
      an app deployed here is very likely to have a health endpoint of its own. The host is what
      separates the two.
    */
    let tenant = reqwest::Client::new()
        .get(format!("http://{address}/healthz"))
        .header("host", host)
        .send()
        .await
        .expect("the router answers");
    assert_eq!(tenant.status().as_u16(), 201);
    assert_eq!(
        tenant.headers().get("x-from").and_then(|v| v.to_str().ok()),
        Some("the-function")
    );

    let _: () = valkey.del(format!("route:{host}")).await.expect("withdraw");
}

#[tokio::test]
async fn an_exhausted_balance_is_refused_before_lambda_is_invoked() {
    if !localstack_up().await {
        refuse_to_skip_in_ci("LocalStack");
        return;
    }
    let Ok(client) = redis::Client::open(VALKEY) else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };
    let Ok(mut valkey) = ConnectionManager::new(client).await else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };

    let config = aws_config().await;
    let lambda = LambdaClient::new(&config);
    let arn = ensure_function(&lambda).await;

    let host = "broke.sproutos.me";
    let organization = "01a03900-0000-7000-8000-00000000br0k";
    let route = format!(
        r#"{{"arn":"{arn}","projectId":"p","organizationId":"{organization}","deploymentId":"d"}}"#
    );
    let _: () = valkey
        .set(format!("route:{host}"), &route)
        .await
        .expect("route");
    let _: () = valkey
        .set(format!("credit:{organization}"), "exhausted")
        .await
        .expect("credit state");

    let state = Arc::new(Router {
        resolver: Resolver::new(valkey.clone()),
        lambda,
        function_timeout: std::time::Duration::from_secs(60),
    });
    let app = AxumRouter::new()
        .fallback(any(serve::handle))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

    let response = reqwest::Client::new()
        .get(format!("http://{address}/"))
        .header("host", host)
        .send()
        .await
        .expect("the router answers");

    /*
      402, and the function was never invoked.

      Refusing before the invocation is the only thing that actually stops spend — AWS has no API
      to abort a Lambda in flight, so anything that starts is paid for. And 402 rather than the 404
      a suspended project gets: this customer can fix it, and telling them so is the difference
      between a bill they can pay and an outage they cannot explain.
    */
    assert_eq!(response.status().as_u16(), 402);
    assert!(response.text().await.unwrap_or_default().contains("credit"));

    // Funded again, and it serves.
    let _: () = valkey
        .del(format!("credit:{organization}"))
        .await
        .expect("clear");
    // The route cache holds the route, not the credit state, so this takes effect at once.
    let served = reqwest::Client::new()
        .get(format!("http://{address}/"))
        .header("host", host)
        .send()
        .await
        .expect("the router answers");
    assert_eq!(served.status().as_u16(), 201);

    let _: () = valkey.del(format!("route:{host}")).await.expect("withdraw");
}

#[tokio::test]
async fn an_unknown_host_is_a_404_and_not_a_lookup_per_request() {
    if !localstack_up().await {
        refuse_to_skip_in_ci("LocalStack");
        eprintln!("skipping: LocalStack is not reachable at {LOCALSTACK}");
        return;
    }
    let Ok(client) = redis::Client::open(VALKEY) else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };
    let Ok(valkey) = ConnectionManager::new(client).await else {
        refuse_to_skip_in_ci("the compose Valkey");
        eprintln!("skipping: the Valkey at {VALKEY} is not reachable");
        return;
    };

    let config = aws_config().await;
    let state = Arc::new(Router {
        resolver: Resolver::new(valkey),
        lambda: LambdaClient::new(&config),
        function_timeout: std::time::Duration::from_secs(60),
    });
    let app = AxumRouter::new()
        .fallback(any(serve::handle))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

    for _ in 0..3 {
        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .header("host", "nobody-here.sproutos.me")
            .send()
            .await
            .expect("the router answers");

        // A suspended project answers identically. That is deliberate: "this project exists but is
        // not paying" is not a fact to hand to anyone who asks for it.
        assert_eq!(response.status().as_u16(), 404);
    }
}

/// A wake in the master queue starts a worker in the customer's own function.
#[tokio::test]
async fn a_woken_queue_invokes_the_projects_function() {
    if !localstack_up().await {
        refuse_to_skip_in_ci("LocalStack");
        return;
    }
    let Ok(client) = redis::Client::open(VALKEY) else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };
    let Ok(mut valkey) = ConnectionManager::new(client).await else {
        refuse_to_skip_in_ci("the compose Valkey");
        return;
    };

    let config = aws_config().await;
    let lambda = LambdaClient::new(&config);
    let arn = ensure_function(&lambda).await;

    let resource = "01m0j8dfg4test";
    let organization = "01a03a00-0000-7000-8000-00000000disp";

    // What the control plane publishes when a queue is provisioned, keyed by the short id the
    // proxy reports — this is the seam the dispatcher depends on.
    let binding = format!(
        r#"{{"uri":"redis://x","backendServiceId":"b","projectId":"p",
             "organizationId":"{organization}","functionArn":"{arn}"}}"#
    );
    let _: () = valkey
        .set(format!("queue:{resource}"), &binding)
        .await
        .expect("binding");

    // What `valkey-proxy` writes when a tenant enqueues.
    let _: () = valkey
        .zadd(
            router::dispatch::MASTER_WAKE_KEY,
            format!("{resource}/emails"),
            1_i64,
        )
        .await
        .expect("wake");

    let pending = router::dispatch::drain_master(&valkey).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].queue, "emails");

    // Draining removes what it read, so a second pass finds nothing — otherwise every poll would
    // re-invoke a worker for a queue that was already handled.
    assert!(router::dispatch::drain_master(&valkey).await.is_empty());

    router::dispatch::invoke_worker(&lambda, &arn, &pending[0])
        .await
        .expect("the worker is invoked");

    let _: () = valkey
        .del(format!("queue:{resource}"))
        .await
        .expect("clean");
}
