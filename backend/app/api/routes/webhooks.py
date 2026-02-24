import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.models import Message

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.get("/")
def read_webhooks(session: SessionDep, current_user: CurrentUser) -> Any:
    """
    Retrieve webhooks.
    """
    return {"webhooks": []}


@router.get("/{id}")
def read_webhook(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get webhook by ID.
    """
    raise HTTPException(status_code=404, detail="Webhook not found")


@router.post("/")
def create_webhook(session: SessionDep, current_user: CurrentUser) -> Any:
    """
    Create new webhook.
    """
    return {"id": str(uuid.uuid4()), "created_by": str(current_user.id)}


@router.put("/{id}")
def update_webhook(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """
    Update a webhook.
    """
    raise HTTPException(status_code=404, detail="Webhook not found")


@router.delete("/{id}")
def delete_webhook(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a webhook.
    """
    raise HTTPException(status_code=404, detail="Webhook not found")
