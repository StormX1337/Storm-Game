import re
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import cache
from app.api.deps import current_user
from app.config import get_settings
from app.db import get_db
from app.models import User, UserSession
from app.security import hash_password, new_session_token, token_digest, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Credentials(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(min_length=1, max_length=256)


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "role": u.role, "created_at": u.created_at}


def _start_session(db: Session, user: User, request: Request, response: Response) -> None:
    s = get_settings()
    token = new_session_token()
    now = datetime.now(UTC)
    db.add(
        UserSession(
            token_hash=token_digest(token),
            user_id=user.id,
            expires_at=now + timedelta(hours=s.session_ttl_hours),
            ip=request.client.host if request.client else None,
            user_agent=(request.headers.get("user-agent") or "")[:512],
        )
    )
    user.last_login_at = now
    db.commit()
    response.set_cookie(
        s.session_cookie_name,
        token,
        max_age=s.session_ttl_hours * 3600,
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
        path="/",
    )


def _client_key(request: Request, email: str) -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}:{email.lower()}"


@router.post("/register", status_code=201)
def register(
    body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)
):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Enter a valid email address")
    if len(body.password) < 10:
        raise HTTPException(422, "Password must be at least 10 characters")
    if cache.rate_limited(f"register:{request.client.host if request.client else '?'}", 10, 3600):
        raise HTTPException(429, "Too many registrations from this address, try later")
    if db.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(409, "An account with this email already exists")
    first = db.scalar(select(func.count(User.id))) == 0
    role = "admin" if first and get_settings().first_user_is_admin else "user"
    user = User(email=email, password_hash=hash_password(body.password), role=role, preferences={})
    db.add(user)
    db.commit()
    _start_session(db, user, request, response)
    return user_out(user)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if cache.rate_limited(f"login:{_client_key(request, email)}", 10, 900):
        raise HTTPException(429, "Too many attempts, try again in 15 minutes")
    user = db.scalar(select(User).where(User.email == email))
    # Verify against a dummy hash when the user does not exist so response
    # time does not reveal which emails are registered.
    valid = verify_password(user.password_hash if user else _DUMMY_HASH, body.password)
    if user is None or not valid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account disabled")
    _start_session(db, user, request, response)
    return user_out(user)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    s = get_settings()
    token = request.cookies.get(s.session_cookie_name)
    if token:
        sess = db.scalar(select(UserSession).where(UserSession.token_hash == token_digest(token)))
        if sess is not None:
            db.delete(sess)
            db.commit()
    response.delete_cookie(s.session_cookie_name, path="/")


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user_out(user)


_DUMMY_HASH = hash_password("not-a-real-password-used-for-timing")
