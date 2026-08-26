import datetime
from typing import Optional

from beanie import Document
from beanie import PydanticObjectId


class User(Document):
    user_id: str
    email: Optional[str] = None
    is_admin: bool = False
    is_staff: bool = False
    is_examiner: bool = False
    name: Optional[str] = None
    current_team: Optional[PydanticObjectId] = None
    api_token_hash: Optional[str] = None
    api_token_created_at: Optional[datetime.datetime] = None
    api_token_expires_at: Optional[datetime.datetime] = None
    browser_automation_session_id: Optional[str] = None
    m365_enabled: bool = False
    m365_connected_at: Optional[datetime.datetime] = None
    password_hash: Optional[str] = None
    # Set ("oauth"/"saml") whenever the account signs in via an identity
    # provider. Once set, the provider owns the email: profile edits to it are
    # blocked, because every SSO login syncs the address back from the IdP.
    # password_hash alone can't tell — SSO users may also set a local password.
    sso_provider: Optional[str] = None
    # Incremented to invalidate all outstanding access/refresh tokens (e.g. on
    # password reset, email change, or account recovery). Tokens embed the value
    # they were minted with; get_current_user/refresh reject any token whose
    # version is stale.
    token_version: int = 0
    is_demo_user: bool = False
    # Legacy clock field from the 14-day-trial era. New trials are token-
    # metered and leave this None; feedback_prompt_service is None-safe.
    demo_expires_at: Optional[datetime.datetime] = None
    # active | exhausted | locked ("expired"/"locked" are legacy clock states;
    # "exhausted" is soft — the app stays browsable, only LLM spend is gated).
    demo_status: Optional[str] = None
    # Lifetime LLM token budget for this trial account. None = the deployment
    # default (Settings.trial_token_budget); raised by feedback-priced top-ups
    # from the trial-end screen (demo_service.self_topup_trial).
    trial_token_budget: Optional[int] = None
    # Set once the account has demonstrably received mail at its address — by
    # clicking any emailed sign-in/reset link, or by arriving through SSO. Only
    # gates LLM spend for trial accounts (see trial_budget.check_*); staff on a
    # self-hosted deployment arrive by bootstrap, invite, or SSO and are never
    # asked. Accounts predating the field read False and are verified by their
    # next emailed link.
    email_verified: bool = False
    organization_id: Optional[str] = None  # org uuid for university hierarchy

    # Engagement tracking
    last_login_at: Optional[datetime.datetime] = None
    first_session_completed: bool = False
    onboarding_drip_step: int = 0  # 0=not started, 1-4=sent step N
    onboarding_drip_next_at: Optional[datetime.datetime] = None  # when to send next drip
    last_nudge_sent_at: Optional[datetime.datetime] = None
    email_preferences: dict = {}  # {"onboarding": True, "nudges": True}

    class Settings:
        name = "user"
        indexes = [
            "user_id",
            "email",
            "api_token_hash",
        ]
