# API Reference

All endpoints are mounted under the `/api/v1/` prefix.

Base URL: `http://localhost:8000/api/v1`

Interactive docs: `http://localhost:8000/docs`

OpenAPI spec: `http://localhost:8000/api/v1/openapi.json`

---

## Authentication

Most endpoints require a valid JWT bearer token. Obtain one via the login endpoint.

Include the token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

---

## Login

Tag: `login`

### POST /login/access-token

OAuth2 compatible token login. Returns an access token for future requests.

<!-- REVIEW NEEDED: Commit ebc1809 added rate limiting mention in docstring
("Rate limited to 5 attempts per minute per IP") but no visible enforcement
in code. Verify if this is aspirational or implemented. -->

- **Auth:** None (public)
- **Request Body:** `application/x-www-form-urlencoded`
  - `username` (string, required) — User email
  - `password` (string, required) — User password
- **Response:** `Token`
  - `access_token` (string)
  - `token_type` (string, default: `"bearer"`)
- **Errors:**
  - `400` — Incorrect email or password
  - `400` — Inactive user

### POST /login/test-token

Test access token validity.

- **Auth:** Bearer token required
- **Response:** `UserPublic`

### POST /password-recovery/{email}

Send a password recovery email.

- **Auth:** None (public)
- **Path Params:**
  - `email` (string, required)
- **Response:** `Message`

### POST /reset-password/

Reset password using a recovery token.

- **Auth:** None (public)
- **Request Body:** `NewPassword`
  - `token` (string, required)
  - `new_password` (string, required, min: 8, max: 128)
- **Response:** `Message`
- **Errors:**
  - `400` — Invalid token
  - `400` — Inactive user

---

## Users

Tag: `users` | Prefix: `/users`

### GET /users/

Retrieve all users (paginated).

- **Auth:** Superuser only
- **Query Params:**
  - `skip` (int, default: 0)
  - `limit` (int, default: 100)
- **Response:** `UsersPublic`
  - `data` (list of `UserPublic`)
  - `count` (int)

### POST /users/

Create a new user.

- **Auth:** Superuser only
- **Request Body:** `UserCreate`
  - `email` (EmailStr, required)
  - `password` (string, required, min: 8, max: 128)
  - `full_name` (string, optional, max: 255)
  - `is_active` (bool, default: true)
  - `is_superuser` (bool, default: false)
- **Response:** `UserPublic`
- **Errors:**
  - `400` — User with this email already exists

### GET /users/me

Get the current authenticated user.

- **Auth:** Bearer token required
- **Response:** `UserPublic`

### PATCH /users/me

Update the current user's profile.

- **Auth:** Bearer token required
- **Request Body:** `UserUpdateMe`
  - `full_name` (string, optional, max: 255)
  - `email` (EmailStr, optional, max: 255)
- **Response:** `UserPublic`
- **Errors:**
  - `409` — User with this email already exists

### PATCH /users/me/password

Update the current user's password.

- **Auth:** Bearer token required
- **Request Body:** `UpdatePassword`
  - `current_password` (string, required, min: 8, max: 128)
  - `new_password` (string, required, min: 8, max: 128)
- **Response:** `Message`
- **Errors:**
  - `400` — Incorrect password
  - `400` — New password cannot be the same as the current one

### DELETE /users/me

Delete the current user's account.

- **Auth:** Bearer token required
- **Response:** `Message`
- **Errors:**
  - `403` — Super users are not allowed to delete themselves

### POST /users/signup

Register a new user (open registration).

- **Auth:** None (public)
- **Request Body:** `UserRegister`
  - `email` (EmailStr, required, max: 255)
  - `password` (string, required, min: 8, max: 128)
  - `full_name` (string, optional, max: 255)
- **Response:** `UserPublic`
- **Errors:**
  - `400` — User with this email already exists

### GET /users/{user_id}

Get a specific user by ID.

- **Auth:** Bearer token required (returns own profile or superuser access)
- **Path Params:**
  - `user_id` (UUID, required)
- **Response:** `UserPublic`
- **Errors:**
  - `403` — Not enough privileges
  - `404` — User not found

### PATCH /users/{user_id}

Update a user by ID.

- **Auth:** Superuser only
- **Path Params:**
  - `user_id` (UUID, required)
- **Request Body:** `UserUpdate`
  - `email` (EmailStr, optional)
  - `password` (string, optional, min: 8, max: 128)
  - `full_name` (string, optional, max: 255)
  - `is_active` (bool, optional)
  - `is_superuser` (bool, optional)
- **Response:** `UserPublic`
- **Errors:**
  - `404` — User not found
  - `409` — User with this email already exists

### DELETE /users/{user_id}

Delete a user by ID. Also deletes all items owned by the user.

- **Auth:** Superuser only
- **Path Params:**
  - `user_id` (UUID, required)
- **Response:** `Message`
- **Errors:**
  - `403` — Super users are not allowed to delete themselves
  - `404` — User not found

---

## Items

Tag: `items` | Prefix: `/items`

### GET /items/

Retrieve items (paginated). Superusers see all items; regular users see only their own.

- **Auth:** Bearer token required
- **Query Params:**
  - `skip` (int, default: 0)
  - `limit` (int, default: 100)
  - `search` (string, optional) — Filter items by search term
- **Response:** `ItemsPublic`
  - `data` (list of `ItemPublic`)
  - `count` (int)

### GET /items/{id}

Get an item by ID.

- **Auth:** Bearer token required (owner or superuser)
- **Path Params:**
  - `id` (UUID, required)
- **Response:** `ItemPublic`
- **Errors:**
  - `403` — Not enough permissions
  - `404` — Item not found

### POST /items/

Create a new item.

- **Auth:** Bearer token required
- **Request Body:** `ItemCreate`
  - `title` (string, required, min: 1, max: 255)
  - `description` (string, optional, max: 255)
- **Response:** `ItemPublic`

### PUT /items/{id}

Update an item.

- **Auth:** Bearer token required (owner or superuser)
- **Path Params:**
  - `id` (UUID, required)
- **Request Body:** `ItemUpdate`
  - `title` (string, optional, min: 1, max: 255)
  - `description` (string, optional, max: 255)
- **Response:** `ItemPublic`
- **Errors:**
  - `403` — Not enough permissions
  - `404` — Item not found

### DELETE /items/{id}

Delete an item.

- **Auth:** Bearer token required (owner or superuser)
- **Path Params:**
  - `id` (UUID, required)
- **Response:** `Message`
- **Errors:**
  - `403` — Not enough permissions
  - `404` — Item not found

### DELETE /items/bulk

Bulk delete items by IDs. Only the owner or a superuser can delete each item.

- **Auth:** Bearer token required
- **Query Params:**
  - `item_ids` (list of UUID, required)
- **Response:** `Message`
- **Errors:**
  - `403` — Not enough permissions
  - `404` — Item {id} not found

---

## Webhooks

Tag: `webhooks` | Prefix: `/webhooks`

### GET /webhooks/

Retrieve all webhooks for the current user.

- **Auth:** Bearer token required
- **Response:** `{ "webhooks": [] }`

### GET /webhooks/{id}

Get a webhook by ID.

- **Auth:** Bearer token required
- **Path Params:**
  - `id` (UUID, required)
- **Errors:**
  - `404` — Webhook not found

### POST /webhooks/

Create a new webhook.

- **Auth:** Bearer token required
- **Response:** `{ "id": string, "created_by": string }`

### PUT /webhooks/{id}

Update a webhook.

- **Auth:** Bearer token required
- **Path Params:**
  - `id` (UUID, required)
- **Errors:**
  - `404` — Webhook not found

### DELETE /webhooks/{id}

Delete a webhook.

- **Auth:** Bearer token required
- **Path Params:**
  - `id` (UUID, required)
- **Response:** `Message`
- **Errors:**
  - `404` — Webhook not found

---

## Utilities

Tag: `utils` | Prefix: `/utils`

### POST /utils/test-email/

Send a test email.

- **Auth:** Superuser only
- **Query Params:**
  - `email_to` (EmailStr, required)
- **Response (201):** `Message`

### GET /utils/health-check/

Health check endpoint.

- **Auth:** None (public)
- **Response:** `true`

---

## Private (Internal)

Tag: `private` | Prefix: `/private`

### POST /private/users/

Create a new user (service-to-service).

- **Auth:** None (internal use)
- **Request Body:** `PrivateUserCreate`
  - `email` (string, required)
  - `password` (string, required)
  - `full_name` (string, required)
  - `is_verified` (bool, default: false)
- **Response:** `UserPublic`

---

## Data Models

### UserPublic

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | User ID |
| email | EmailStr | User email |
| is_active | bool | Whether user is active |
| is_superuser | bool | Whether user is superuser |
| full_name | string or null | Full name |
| created_at | datetime or null | Creation timestamp |

### ItemPublic

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Item ID |
| title | string | Item title |
| description | string or null | Item description |
| owner_id | UUID | Owner user ID |
| created_at | datetime or null | Creation timestamp |

### Token

| Field | Type | Description |
|-------|------|-------------|
| access_token | string | JWT access token |
| token_type | string | Token type (default: "bearer") |

### Message

| Field | Type | Description |
|-------|------|-------------|
| message | string | Response message |
