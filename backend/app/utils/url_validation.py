"""Validate URLs before making server-side requests (SSRF protection)."""

import ipaddress
import socket
from urllib.parse import urlparse

BLOCKED_HOSTS = frozenset({
    "metadata.google.internal",
    "metadata.internal",
    "instance-data",
})


def allowed_private_hosts() -> frozenset[str]:
    """Hostnames an operator has exempted from the private-address block.

    Read from ``OUTBOUND_URL_ALLOWED_HOSTS`` (comma-separated, exact
    hostnames). Settings are rebuilt on each call rather than cached here --
    the list is a handful of names and the parse is trivial -- but in the
    Dockerized deploy the value arrives through the container environment,
    so changing it still means restarting the api and celery containers.
    The metadata hostnames in ``BLOCKED_HOSTS`` cannot be exempted; listing
    one is ignored.
    """
    from app.config import Settings

    raw = Settings().outbound_url_allowed_hosts or ""
    return frozenset(
        h.strip().lower().rstrip(".")
        for h in raw.split(",")
        if h.strip() and h.strip().lower() not in BLOCKED_HOSTS
    )


def normalize_crawl_url(url: str) -> str:
    """Normalize a URL for crawl deduplication: strip fragments, trailing slashes.

    ``example.com``, ``example.com/`` and ``example.com#section`` all serve the
    same page; normalizing them to one form keeps crawlers from fetching (and
    counting) the same page once per spelling.
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    clean = f"{parsed.scheme}://{parsed.netloc}{path}"
    if parsed.query:
        clean += f"?{parsed.query}"
    return clean


def validate_outbound_url(url: str, allowed_hosts: frozenset[str] | None = None) -> str:
    """Validate that *url* is safe for server-side HTTP requests.

    Blocks private/loopback/link-local IPs, non-HTTP(S) schemes, and
    cloud metadata endpoints.  Raises ``ValueError`` on rejection.

    A hostname in *allowed_hosts* (default: the operator's
    ``OUTBOUND_URL_ALLOWED_HOSTS``) skips only the address-range check: the
    scheme must still be HTTP(S), the metadata hostnames stay blocked, and
    the name must still resolve. The match is on the exact hostname, so an
    exemption for ``router.example.edu`` says nothing about any other name
    that happens to share its address.
    """
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Blocked URL scheme: {parsed.scheme!r}")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname")

    if hostname in BLOCKED_HOSTS:
        raise ValueError(f"Blocked hostname: {hostname}")

    # Resolve DNS and reject private / reserved addresses
    try:
        infos = socket.getaddrinfo(hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ValueError(f"Cannot resolve hostname: {hostname}")

    if allowed_hosts is None:
        allowed_hosts = allowed_private_hosts()
    if hostname.lower().rstrip(".") in allowed_hosts:
        return url

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError(
                f"URL resolves to blocked IP range: {ip}. If {hostname} is a "
                "service this deployment should reach, an operator can add it "
                "to OUTBOUND_URL_ALLOWED_HOSTS in the backend .env."
            )

    return url
