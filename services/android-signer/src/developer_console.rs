//! Android Developer Console package-name registration.
//!
//! The API is early-access and its discovery document requires an authenticated caller.  We load
//! that document after refreshing OAuth instead of freezing guessed REST paths into the signer.
//! OAuth credentials and ownership tokens exist only in this process.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;

use anyhow::{Context as _, bail};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::APK_MIME;

pub const SCOPE: &str = "https://www.googleapis.com/auth/androiddeveloperconsole";
pub const DEFAULT_DISCOVERY_URL: &str =
    "https://androiddeveloperconsole.googleapis.com/$discovery/rest?version=v1";
pub const DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Clone)]
pub struct DeveloperConsoleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub developer_account: Option<String>,
    pub package_display_name: String,
    pub justification: Option<String>,
    pub token_url: String,
    pub discovery_url: String,
}

impl DeveloperConsoleConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let required = |name: &str| {
            std::env::var(name).with_context(|| format!("{name} is not set on the signer host"))
        };
        Ok(Self {
            client_id: required("APK_SIGNER_GOOGLE_OAUTH_CLIENT_ID")?,
            client_secret: required("APK_SIGNER_GOOGLE_OAUTH_CLIENT_SECRET")?,
            refresh_token: load_refresh_token()?,
            developer_account: std::env::var("APK_SIGNER_ANDROID_DEVELOPER_ACCOUNT")
                .ok()
                .filter(|value| !value.is_empty()),
            package_display_name: std::env::var("APK_SIGNER_ANDROID_PACKAGE_DISPLAY_NAME")
                .unwrap_or_else(|_| "SproutOS".to_owned()),
            justification: std::env::var("APK_SIGNER_ANDROID_REGISTRATION_JUSTIFICATION")
                .ok()
                .filter(|value| !value.is_empty()),
            token_url: std::env::var("APK_SIGNER_GOOGLE_OAUTH_TOKEN_URL")
                .unwrap_or_else(|_| DEFAULT_TOKEN_URL.to_owned()),
            discovery_url: std::env::var("APK_SIGNER_ANDROID_DEVELOPER_DISCOVERY_URL")
                .unwrap_or_else(|_| DEFAULT_DISCOVERY_URL.to_owned()),
        })
    }

    pub fn authorization_url(client_id: &str, redirect_uri: &str) -> anyhow::Result<String> {
        let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")?;
        url.query_pairs_mut()
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        Ok(url.into())
    }

    pub async fn exchange_authorization_code(
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
        token_url: &str,
    ) -> anyhow::Result<String> {
        require_google_or_loopback(token_url, DEFAULT_TOKEN_URL, "OAuth token")?;
        #[derive(Deserialize)]
        struct Exchange {
            refresh_token: Option<String>,
            scope: Option<String>,
        }
        let response = reqwest::Client::new()
            .post(token_url)
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .context("Google OAuth authorization-code exchange failed")?;
        if !response.status().is_success() {
            bail!(
                "Google OAuth authorization-code exchange was refused with HTTP {}",
                response.status()
            )
        }
        let exchange: Exchange = response
            .json()
            .await
            .context("Google OAuth authorization-code response was malformed")?;
        if exchange
            .scope
            .as_deref()
            .is_some_and(|scope| !scope.split_ascii_whitespace().any(|value| value == SCOPE))
        {
            bail!("Google OAuth consent omitted the Android Developer Console scope")
        }
        exchange
            .refresh_token
            .filter(|token| !token.is_empty())
            .context("Google did not return an offline refresh token; repeat consent with prompt=consent")
    }
}

fn load_refresh_token() -> anyhow::Result<String> {
    if let Ok(path) = std::env::var("APK_SIGNER_GOOGLE_OAUTH_REFRESH_TOKEN_FILE") {
        let path = std::path::PathBuf::from(path);
        assert_private_file(&path)?;
        return Ok(std::fs::read_to_string(path)?.trim().to_owned());
    }
    std::env::var("APK_SIGNER_GOOGLE_OAUTH_REFRESH_TOKEN")
        .context("APK_SIGNER_GOOGLE_OAUTH_REFRESH_TOKEN_FILE is not set on the signer host")
}

pub fn write_refresh_token(path: &Path, token: &str) -> anyhow::Result<()> {
    if token.is_empty() || token.contains(['\r', '\n']) {
        bail!("Google OAuth refresh token is malformed")
    }
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt as _;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?
    };
    #[cfg(not(unix))]
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn assert_private_file(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    if std::fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
        bail!("Google OAuth refresh-token file must not be accessible by group or other users")
    }
    Ok(())
}

#[cfg(not(unix))]
fn assert_private_file(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationStep {
    Registered,
    PendingReview,
    OwnershipRequired { key_name: String, token: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationOutcome {
    pub developer_account: String,
    pub step: RegistrationStep,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    root_url: String,
    service_path: String,
    #[serde(default)]
    resources: BTreeMap<String, Resource>,
    #[serde(default)]
    schemas: BTreeMap<String, Schema>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Resource {
    #[serde(default)]
    methods: BTreeMap<String, Method>,
    #[serde(default)]
    resources: BTreeMap<String, Resource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Method {
    id: String,
    path: String,
    http_method: String,
    #[serde(default)]
    parameters: BTreeMap<String, Parameter>,
    media_upload: Option<MediaUpload>,
    request: Option<SchemaRef>,
}

#[derive(Debug, Clone, Deserialize)]
struct SchemaRef {
    #[serde(rename = "$ref")]
    reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Schema {
    #[serde(default)]
    properties: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct Parameter {
    location: String,
    required: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MediaUpload {
    protocols: MediaProtocols,
}

#[derive(Debug, Clone, Deserialize)]
struct MediaProtocols {
    simple: Option<MediaPath>,
}

#[derive(Debug, Clone, Deserialize)]
struct MediaPath {
    path: String,
}

pub struct GoogleDeveloperConsole {
    http: reqwest::Client,
    config: DeveloperConsoleConfig,
}

impl GoogleDeveloperConsole {
    pub fn new(config: DeveloperConsoleConfig) -> anyhow::Result<Self> {
        for (name, value) in [
            ("OAuth client id", &config.client_id),
            ("OAuth client secret", &config.client_secret),
            ("OAuth refresh token", &config.refresh_token),
        ] {
            if value.is_empty() {
                bail!("{name} is empty")
            }
        }
        require_google_or_loopback(&config.token_url, DEFAULT_TOKEN_URL, "OAuth token")?;
        require_google_or_loopback(
            &config.discovery_url,
            DEFAULT_DISCOVERY_URL,
            "Android Developer Console discovery",
        )?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            config,
        })
    }

    async fn session(&self) -> anyhow::Result<Session> {
        let response = self
            .http
            .post(&self.config.token_url)
            .form(&[
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("refresh_token", self.config.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .context("Google OAuth refresh request failed")?;
        if !response.status().is_success() {
            bail!(
                "Google OAuth refresh was refused with HTTP {}",
                response.status()
            )
        }
        let token: TokenResponse = response
            .json()
            .await
            .context("Google OAuth refresh response was malformed")?;
        if token.token_type != "Bearer" || token.access_token.is_empty() {
            bail!("Google OAuth refresh response did not contain a bearer token")
        }
        if token
            .scope
            .as_deref()
            .is_some_and(|scope| !scope.split_ascii_whitespace().any(|value| value == SCOPE))
        {
            bail!("Google OAuth token omitted the Android Developer Console scope")
        }
        let response = self
            .http
            .get(&self.config.discovery_url)
            .header(AUTHORIZATION, format!("Bearer {}", token.access_token))
            .send()
            .await
            .context("Android Developer Console discovery request failed")?;
        if !response.status().is_success() {
            bail!(
                "Android Developer Console discovery was refused with HTTP {}",
                response.status()
            )
        }
        let discovery: Discovery = response
            .json()
            .await
            .context("Android Developer Console discovery document was malformed")?;
        if discovery.root_url != "https://androiddeveloperconsole.googleapis.com/"
            && !is_loopback(&discovery.root_url)
        {
            bail!("Android Developer Console discovery returned an unexpected API origin")
        }
        Ok(Session {
            http: self.http.clone(),
            token: token.access_token,
            discovery,
        })
    }

    /// Reconcile one exact package/certificate pair. Repeated calls list before creating, and a
    /// create conflict is recovered by listing again.
    pub async fn begin_registration(
        &self,
        package_name: &str,
        fingerprint: &str,
        certificate_der_base64: &str,
    ) -> anyhow::Result<RegistrationOutcome> {
        validate_fingerprint(fingerprint)?;
        if certificate_der_base64.is_empty() {
            bail!("signing identity predates stored public-certificate support; reprovision it")
        }
        let session = self.session().await?;
        let account = self.select_account(&session).await?;
        let package = ensure_package(
            &session,
            &account,
            package_name,
            &self.config.package_display_name,
        )
        .await?;
        let policy = session
            .call(
                "GetAndroidPackageRegistrationPolicy",
                bindings(&[("parent", &account), ("name", &package)]),
                Value::Null,
            )
            .await?;
        let strategy = string_field(&policy, &["keySelectionStrategy"])
            .context("registration policy omitted keySelectionStrategy")?;
        let existing = list_key(&session, &package, fingerprint).await?;
        let mut key = match existing {
            Some(key) => key,
            None => {
                if strategy == "SELECT_KEY_FROM_LIST" && !known_fingerprint(&policy, fingerprint) {
                    bail!("package name requires a known signing key not owned by SproutOS")
                }
                let body = json!({
                    "certificateFingerprintSha256": fingerprint,
                    "certificate": certificate_der_base64,
                    "certificateDer": certificate_der_base64,
                    "certificateDerBytes": certificate_der_base64,
                    "publicCertificate": certificate_der_base64,
                });
                session
                    .call(
                        "CreateAndroidPackageKey",
                        bindings(&[("parent", &package), ("name", &package)]),
                        body,
                    )
                    .await
                    .or_else(|error| {
                        if provider_status(&error) == Some(409) {
                            Ok(Value::Null)
                        } else {
                            Err(error)
                        }
                    })?;
                list_key(&session, &package, fingerprint)
                    .await?
                    .context("created signing key was not returned by the provider")?
            }
        };
        let justification = string_field(&key, &["justificationRequired"]);
        if justification == Some("REQUIRED") {
            let rationale = self.config.justification.as_deref().context(
                "Android package-name registration requires an operator-approved justification",
            )?;
            let key_name = resource_name(&key, "Android package key")?;
            session
                .call(
                    "JustifyAndroidPackageKeyRegistration",
                    bindings(&[("name", key_name), ("parent", key_name)]),
                    json!({ "justification": rationale }),
                )
                .await?;
            key = list_key(&session, &package, fingerprint)
                .await?
                .context("justified signing key disappeared")?;
        }
        Ok(RegistrationOutcome {
            developer_account: account,
            step: registration_step(&key)?,
        })
    }

    pub async fn verify_ownership(&self, key_name: &str, apk: &Path) -> anyhow::Result<()> {
        let session = self.session().await?;
        session
            .upload(
                "VerifyAndroidPackageKeyOwnership",
                bindings(&[("name", key_name), ("parent", key_name)]),
                apk,
            )
            .await?;
        Ok(())
    }

    async fn select_account(&self, session: &Session) -> anyhow::Result<String> {
        let body = session
            .call("ListDeveloperAccounts", BTreeMap::new(), Value::Null)
            .await?;
        let accounts = array_field(&body, &["developerAccounts", "accounts"]);
        let verified: Vec<&Value> = accounts
            .iter()
            .filter(|value| string_field(value, &["verificationState"]) == Some("VERIFIED"))
            .collect();
        if let Some(selected) = &self.config.developer_account {
            let account = verified
                .into_iter()
                .find(|value| string_field(value, &["name"]) == Some(selected))
                .map(|_| selected.clone())
                .context("configured Android Developer Console account is absent or unverified")?;
            validate_developer_account(&account)?;
            return Ok(account);
        }
        if verified.len() != 1 {
            bail!(
                "OAuth identity must expose exactly one verified developer account or APK_SIGNER_ANDROID_DEVELOPER_ACCOUNT must select one"
            )
        }
        let account = resource_name(verified[0], "developer account")?.to_owned();
        validate_developer_account(&account)?;
        Ok(account)
    }
}

fn validate_developer_account(account: &str) -> anyhow::Result<()> {
    let Some(number) = account.strip_prefix("developerAccounts/") else {
        bail!("Android Developer Console returned an invalid developer-account resource name")
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("Android Developer Console returned an invalid developer-account resource name")
    }
    Ok(())
}

struct Session {
    http: reqwest::Client,
    token: String,
    discovery: Discovery,
}

impl Session {
    async fn call(
        &self,
        method_name: &str,
        values: BTreeMap<String, String>,
        body: Value,
    ) -> anyhow::Result<Value> {
        let method = find_method(&self.discovery.resources, method_name)?;
        let url = method_url(&self.discovery, method, &values, false)?;
        let mut request = self
            .http
            .request(method.http_method.parse()?, url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token));
        if !body.is_null() {
            request = request.json(&filtered_body(&self.discovery, method, body)?);
        }
        provider_response(request.send().await, method_name).await
    }

    async fn upload(
        &self,
        method_name: &str,
        values: BTreeMap<String, String>,
        apk: &Path,
    ) -> anyhow::Result<Value> {
        let method = find_method(&self.discovery.resources, method_name)?;
        let url = method_url(&self.discovery, method, &values, true)?;
        let bytes = tokio::fs::read(apk).await?;
        let request = self
            .http
            .request(method.http_method.parse()?, url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header(CONTENT_TYPE, APK_MIME)
            .body(bytes);
        provider_response(request.send().await, method_name).await
    }
}

async fn provider_response(
    response: Result<reqwest::Response, reqwest::Error>,
    operation: &str,
) -> anyhow::Result<Value> {
    let response = response.with_context(|| format!("{operation} request failed"))?;
    if !response.status().is_success() {
        bail!(
            "{operation} was refused with provider HTTP {}",
            response.status()
        )
    }
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    response
        .json()
        .await
        .with_context(|| format!("{operation} response was malformed"))
}

fn provider_status(error: &anyhow::Error) -> Option<u16> {
    error
        .to_string()
        .split("provider HTTP ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

async fn ensure_package(
    session: &Session,
    account: &str,
    package_name: &str,
    display_name: &str,
) -> anyhow::Result<String> {
    let listed = session
        .call(
            "ListAndroidPackages",
            bindings(&[("parent", account), ("name", account)]),
            Value::Null,
        )
        .await?;
    if let Some(found) = array_field(&listed, &["androidPackages", "packages"])
        .iter()
        .find(|value| string_field(value, &["packageName"]) == Some(package_name))
    {
        return Ok(resource_name(found, "Android package")?.to_owned());
    }
    let created = session
        .call(
            "CreateAndroidPackage",
            bindings(&[("parent", account), ("name", account)]),
            json!({
                "packageName": package_name,
                "displayName": display_name,
                "friendlyName": display_name
            }),
        )
        .await;
    match created {
        Ok(value) => Ok(resource_name(&value, "created Android package")?.to_owned()),
        Err(error) if provider_status(&error) == Some(409) => {
            let listed = session
                .call(
                    "ListAndroidPackages",
                    bindings(&[("parent", account), ("name", account)]),
                    Value::Null,
                )
                .await?;
            array_field(&listed, &["androidPackages", "packages"])
                .iter()
                .find(|value| string_field(value, &["packageName"]) == Some(package_name))
                .map(|value| resource_name(value, "Android package").map(ToOwned::to_owned))
                .transpose()?
                .context("conflicting Android package create was not recoverable")
        }
        Err(error) => Err(error),
    }
}

async fn list_key(
    session: &Session,
    package: &str,
    fingerprint: &str,
) -> anyhow::Result<Option<Value>> {
    let value = session
        .call(
            "ListAndroidPackageKeys",
            bindings(&[("parent", package), ("name", package)]),
            Value::Null,
        )
        .await?;
    Ok(array_field(&value, &["androidPackageKeys", "keys"])
        .iter()
        .find(|value| {
            string_field(value, &["certificateFingerprintSha256"])
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(fingerprint))
        })
        .cloned())
}

fn registration_step(key: &Value) -> anyhow::Result<RegistrationStep> {
    match string_field(key, &["registrationState"]) {
        Some("REGISTERED" | "REGISTERED_ACTIVE") => Ok(RegistrationStep::Registered),
        Some("IN_REVIEW" | "PENDING_TRANSFER") => Ok(RegistrationStep::PendingReview),
        Some("DRAFT" | "OWNERSHIP_VERIFIED") => {
            if let Some(token) = string_field(key, &["verificationToken"]) {
                return Ok(RegistrationStep::OwnershipRequired {
                    key_name: resource_name(key, "Android package key")?.to_owned(),
                    token: token.to_owned(),
                });
            }
            Ok(RegistrationStep::PendingReview)
        }
        Some(_) => bail!("Android package key returned an unknown registration state"),
        None => bail!("Android package key omitted registrationState"),
    }
}

fn known_fingerprint(policy: &Value, fingerprint: &str) -> bool {
    array_field(policy, &["knownKeys"]).iter().any(|key| {
        string_field(key, &["certificateFingerprintSha256"])
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(fingerprint))
    })
}

fn find_method<'a>(
    resources: &'a BTreeMap<String, Resource>,
    name: &str,
) -> anyhow::Result<&'a Method> {
    fn walk<'a>(resources: &'a BTreeMap<String, Resource>, name: &str) -> Option<&'a Method> {
        for resource in resources.values() {
            if let Some(method) = resource
                .methods
                .values()
                .find(|method| method_matches(&method.id, name))
            {
                return Some(method);
            }
            if let Some(method) = walk(&resource.resources, name) {
                return Some(method);
            }
        }
        None
    }
    walk(resources, name).with_context(|| format!("discovery omitted {name}"))
}

fn method_matches(id: &str, rpc_name: &str) -> bool {
    let normalized = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let id = normalized(id);
    let rpc = normalized(rpc_name);
    if id.ends_with(&rpc) {
        return true;
    }
    let suffix = match rpc_name {
        "ListDeveloperAccounts" => "developeraccountslist",
        "ListAndroidPackages" => "androidpackageslist",
        "CreateAndroidPackage" => "androidpackagescreate",
        "GetAndroidPackageRegistrationPolicy" => "androidpackagesgetregistrationpolicy",
        "ListAndroidPackageKeys" => "androidpackagekeyslist",
        "CreateAndroidPackageKey" => "androidpackagekeyscreate",
        "VerifyAndroidPackageKeyOwnership" => "androidpackagekeysverifyownership",
        "JustifyAndroidPackageKeyRegistration" => "androidpackagekeysjustifyregistration",
        _ => return false,
    };
    id.ends_with(suffix)
}

fn filtered_body(discovery: &Discovery, method: &Method, body: Value) -> anyhow::Result<Value> {
    let Some(reference) = method
        .request
        .as_ref()
        .and_then(|request| request.reference.as_ref())
    else {
        return Ok(body);
    };
    let schema = discovery
        .schemas
        .get(reference)
        .with_context(|| format!("discovery omitted request schema {reference}"))?;
    let object = body
        .as_object()
        .context("Android Developer Console request body is not an object")?;
    let filtered: serde_json::Map<String, Value> = object
        .iter()
        .filter(|(name, _)| schema.properties.contains_key(*name))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    if filtered.is_empty() && !object.is_empty() {
        bail!("Android Developer Console discovery request schema has no supported fields")
    }
    Ok(Value::Object(filtered))
}

fn method_url(
    discovery: &Discovery,
    method: &Method,
    values: &BTreeMap<String, String>,
    upload: bool,
) -> anyhow::Result<String> {
    let mut path = if upload {
        method
            .media_upload
            .as_ref()
            .and_then(|media| media.protocols.simple.as_ref())
            .map(|simple| simple.path.as_str())
            .context("ownership verification discovery omitted simple media upload")?
            .to_owned()
    } else {
        method.path.clone()
    };
    let mut query = Vec::new();
    for (name, parameter) in &method.parameters {
        let value = semantic_value(name, values);
        if parameter.location == "path" {
            let value =
                value.with_context(|| format!("missing discovery path parameter {name}"))?;
            path = path.replace(&format!("{{{name}}}"), value);
            path = replace_template(&path, name, value);
        } else if parameter.location == "query" {
            if let Some(value) = value {
                query.push((name.as_str(), value));
            } else if parameter.required == Some(true) {
                bail!("missing discovery query parameter {name}")
            }
        }
    }
    let base_path = if path.starts_with('/') {
        path.trim_start_matches('/').to_owned()
    } else {
        format!("{}{}", discovery.service_path, path)
    };
    let mut url = url::Url::parse(&format!("{}{}", discovery.root_url, base_path))?;
    for (name, value) in query {
        url.query_pairs_mut().append_pair(name, value);
    }
    if upload {
        url.query_pairs_mut().append_pair("uploadType", "media");
    }
    Ok(url.into())
}

fn replace_template(path: &str, name: &str, value: &str) -> String {
    let prefix = format!("{{{name}=");
    let Some(start) = path.find(&prefix) else {
        return path.to_owned();
    };
    let Some(relative_end) = path[start..].find('}') else {
        return path.to_owned();
    };
    let end = start + relative_end + 1;
    format!("{}{}{}", &path[..start], value, &path[end..])
}

fn semantic_value<'a>(name: &str, values: &'a BTreeMap<String, String>) -> Option<&'a str> {
    values
        .get(name)
        .or_else(|| {
            if name == "parent" || name.contains("developerAccount") {
                values.get("parent")
            } else if name == "name" || name.contains("androidPackage") || name.contains("key") {
                values.get("name")
            } else {
                None
            }
        })
        .map(String::as_str)
}

fn bindings(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

fn array_field<'a>(value: &'a Value, names: &[&str]) -> &'a [Value] {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(Value::as_str))
}

fn resource_name<'a>(value: &'a Value, kind: &str) -> anyhow::Result<&'a str> {
    string_field(value, &["name"]).with_context(|| format!("{kind} omitted its resource name"))
}

fn validate_fingerprint(value: &str) -> anyhow::Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("certificate SHA-256 fingerprint is malformed")
    }
    Ok(())
}

fn is_loopback(raw: &str) -> bool {
    url::Url::parse(raw).ok().is_some_and(|url| {
        matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
    })
}

fn require_google_or_loopback(raw: &str, expected: &str, kind: &str) -> anyhow::Result<()> {
    if raw == expected || is_loopback(raw) {
        return Ok(());
    }
    bail!("{kind} URL must use Google's documented endpoint")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        routing::{get, post},
    };

    #[test]
    fn discovery_paths_drive_requests_including_grpc_templates() {
        let discovery: Discovery = serde_json::from_value(json!({
            "rootUrl": "https://androiddeveloperconsole.googleapis.com/",
            "servicePath": "",
            "resources": { "developerAccounts": { "resources": { "androidPackages": {
                "methods": { "create": {
                    "id": "androiddeveloperconsole.CreateAndroidPackage",
                    "path": "v1/{parent=developerAccounts/*}/androidPackages",
                    "httpMethod": "POST",
                    "parameters": { "parent": { "location": "path", "required": true } }
                }}
            }}}}
        }))
        .unwrap();
        let method = find_method(&discovery.resources, "CreateAndroidPackage").unwrap();
        let url = method_url(
            &discovery,
            method,
            &bindings(&[("parent", "developerAccounts/123")]),
            false,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://androiddeveloperconsole.googleapis.com/v1/developerAccounts/123/androidPackages"
        );
    }

    #[test]
    fn registration_tokens_are_never_part_of_errors() {
        let key = json!({
            "name": "developerAccounts/1/androidPackages/x/keys/1",
            "registrationState": "DRAFT",
            "verificationToken": "secret-token"
        });
        assert!(matches!(
            registration_step(&key).unwrap(),
            RegistrationStep::OwnershipRequired { .. }
        ));
        let unknown = json!({ "registrationState": "FUTURE", "verificationToken": "secret-token" });
        assert!(
            !registration_step(&unknown)
                .unwrap_err()
                .to_string()
                .contains("secret-token")
        );
    }

    #[test]
    fn offline_consent_url_requests_exact_scope_and_fresh_refresh_token() {
        let raw = DeveloperConsoleConfig::authorization_url(
            "client.apps.googleusercontent.com",
            "http://127.0.0.1:8341/oauth/callback",
        )
        .unwrap();
        let url = url::Url::parse(&raw).unwrap();
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("scope").map(String::as_str), Some(SCOPE));
        assert_eq!(
            query.get("access_type").map(String::as_str),
            Some("offline")
        );
        assert_eq!(query.get("prompt").map(String::as_str), Some("consent"));
    }

    #[test]
    fn refresh_token_file_is_created_privately_and_never_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("google-refresh-token");
        write_refresh_token(&path, "refresh-secret").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "refresh-secret");
        assert!(write_refresh_token(&path, "replacement").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn refreshes_oauth_and_reconciles_an_existing_registered_key_from_discovery() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        let discovery_root = root.clone();
        let fingerprint = "a".repeat(64);
        let key_fingerprint = fingerprint.clone();
        let app = Router::new()
            .route(
                "/token",
                post(|| async {
                    Json(json!({
                        "access_token": "short-lived",
                        "token_type": "Bearer",
                        "scope": SCOPE
                    }))
                }),
            )
            .route(
                "/discovery",
                get(move || {
                    let root = discovery_root.clone();
                    async move {
                        Json(json!({
                            "rootUrl": root,
                            "servicePath": "",
                            "resources": {
                                "developerAccounts": {
                                    "methods": { "list": {
                                        "id": "androiddeveloperconsole.developerAccounts.list",
                                        "path": "v1/developerAccounts", "httpMethod": "GET"
                                    }},
                                    "resources": { "androidPackages": {
                                        "methods": {
                                            "list": {
                                                "id": "androiddeveloperconsole.developerAccounts.androidPackages.list",
                                                "path": "v1/{parent=developerAccounts/*}/androidPackages",
                                                "httpMethod": "GET",
                                                "parameters": { "parent": { "location": "path", "required": true } }
                                            },
                                            "policy": {
                                                "id": "androiddeveloperconsole.developerAccounts.androidPackages.getRegistrationPolicy",
                                                "path": "v1/{name=developerAccounts/*/androidPackages/*}/registrationPolicy",
                                                "httpMethod": "GET",
                                                "parameters": { "name": { "location": "path", "required": true } }
                                            }
                                        },
                                        "resources": { "androidPackageKeys": { "methods": { "list": {
                                            "id": "androiddeveloperconsole.developerAccounts.androidPackages.androidPackageKeys.list",
                                            "path": "v1/{parent=developerAccounts/*/androidPackages/*}/androidPackageKeys",
                                            "httpMethod": "GET",
                                            "parameters": { "parent": { "location": "path", "required": true } }
                                        }}}}
                                    }}
                                }
                            }
                        }))
                    }
                }),
            )
            .route(
                "/v1/developerAccounts",
                get(|| async { Json(json!({ "developerAccounts": [{
                    "name": "developerAccounts/123", "verificationState": "VERIFIED"
                }] })) }),
            )
            .route(
                "/v1/developerAccounts/123/androidPackages",
                get(|| async { Json(json!({ "androidPackages": [{
                    "name": "developerAccounts/123/androidPackages/com.sproutos.store",
                    "packageName": "com.sproutos.store", "registrationState": "REGISTERED"
                }] })) }),
            )
            .route(
                "/v1/developerAccounts/123/androidPackages/com.sproutos.store/registrationPolicy",
                get(|| async { Json(json!({ "keySelectionStrategy": "USE_ANY_KEY" })) }),
            )
            .route(
                "/v1/developerAccounts/123/androidPackages/com.sproutos.store/androidPackageKeys",
                get(move || {
                    let fingerprint = key_fingerprint.clone();
                    async move { Json(json!({ "androidPackageKeys": [{
                        "name": "developerAccounts/123/androidPackages/com.sproutos.store/androidPackageKeys/1",
                        "certificateFingerprintSha256": fingerprint,
                        "registrationState": "REGISTERED_ACTIVE"
                    }] })) }
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let console = GoogleDeveloperConsole::new(DeveloperConsoleConfig {
            client_id: "client".into(),
            client_secret: "secret".into(),
            refresh_token: "refresh".into(),
            developer_account: None,
            package_display_name: "SproutOS".into(),
            justification: None,
            token_url: format!("{root}token"),
            discovery_url: format!("{root}discovery"),
        })
        .unwrap();
        let result = console
            .begin_registration("com.sproutos.store", &fingerprint, "Y2VydA==")
            .await
            .unwrap();
        server.abort();
        assert_eq!(result.developer_account, "developerAccounts/123");
        assert_eq!(result.step, RegistrationStep::Registered);
    }
}
