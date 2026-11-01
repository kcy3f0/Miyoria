// `/api/auth/*`: roles, role assignments and platform role mappings. Changes go through the
// `auth` module's `AuthService` (which keeps its cache in sync and writes the audit log); reads
// fall back to the store.

import { type AuthService, AuthServiceKey } from "@miyoria/auth";
import { AuthStoreKey, type RoleAssignment, type RoleDefinition } from "@miyoria/store";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson, readQuery } from "./extract.js";
import { json, noContent, param, type Route } from "./route.js";
import { AccountRefSchema, AuthScopeSchema, scopeEquals } from "./schemas.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import type { AssignRoleRequest } from "./types.js";

function auth(state: ApiState): AuthService {
  return state.service(AuthServiceKey, "auth module");
}

function unknownRole(name: string): ApiError {
  return ApiError.notFound(`unknown role \`${name}\``);
}

/** Highest rank first. */
async function allRoles(state: ApiState): Promise<RoleDefinition[]> {
  const service = state.optional(AuthServiceKey);
  if (service) return service.roles();
  const store = state.service(AuthStoreKey, "auth store");
  const roles = await store.roles();
  return roles.sort((a, b) => b.rank - a.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function roles(state: ApiState): Promise<Response> {
  return json(await allRoles(state));
}

async function role(state: ApiState, c: ApiContext): Promise<Response> {
  const name = param(c, "name");
  const found = (await allRoles(state)).find((r) => r.name === name);
  if (!found) throw unknownRole(name);
  return json(found);
}

const UpsertRoleSchema = z.object({
  rank: z.number().int(),
  grants: z.array(z.string()).default([]),
  denies: z.array(z.string()).default([]),
});

async function upsertRole(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, UpsertRoleSchema);
  const name = param(c, "name");
  const service = auth(state);
  const definition: RoleDefinition = {
    name,
    rank: request.rank,
    grants: request.grants,
    denies: request.denies,
    builtin: false,
  };
  try {
    await service.upsertRole(actorOf(c), definition);
  } catch (error) {
    throw new ApiError(400, ApiError.internal(error).message);
  }
  const stored = service.role(name);
  if (!stored) throw unknownRole(name);
  return json(stored);
}

async function deleteRole(state: ApiState, c: ApiContext): Promise<Response> {
  const name = param(c, "name");
  const service = auth(state);
  if (!service.role(name)) throw unknownRole(name);
  let deleted: boolean;
  try {
    deleted = await service.deleteRole(actorOf(c), name);
  } catch (error) {
    throw ApiError.conflict(ApiError.internal(error).message);
  }
  if (!deleted) throw unknownRole(name);
  return noContent();
}

async function assignments(state: ApiState): Promise<Response> {
  const store = state.service(AuthStoreKey, "auth store");
  const all = await store.allAssignments();
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return json(all);
}

const AssignRoleSchema = z.object({
  account: AccountRefSchema,
  role: z.string(),
  scope: AuthScopeSchema,
});

async function findAssignment(
  state: ApiState,
  request: AssignRoleRequest,
): Promise<RoleAssignment | undefined> {
  const store = state.service(AuthStoreKey, "auth store");
  const all = await store.assignmentsFor(request.account);
  return all.find((a) => a.role === request.role && scopeEquals(a.scope, request.scope));
}

async function assign(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, AssignRoleSchema);
  const service = auth(state);
  if (!service.role(request.role)) throw unknownRole(request.role);
  if (await findAssignment(state, request)) {
    throw ApiError.conflict(
      `\`${request.account.platform}:${request.account.id}\` already has role \`${request.role}\` in that scope`,
    );
  }
  try {
    await service.assign(actorOf(c), request.account, request.role, request.scope);
  } catch (error) {
    throw ApiError.internal(error);
  }
  const stored = await findAssignment(state, request);
  if (!stored) throw new ApiError(500, "the assignment was not stored");
  return json(stored);
}

async function revoke(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, AssignRoleSchema);
  const service = auth(state);
  let removed: boolean;
  try {
    removed = await service.revoke(actorOf(c), request.account, request.role, request.scope);
  } catch (error) {
    throw ApiError.internal(error);
  }
  if (!removed) throw ApiError.notFound("no such role assignment");
  return noContent();
}

const MappingsQuerySchema = z.object({
  platform: z.string({ error: "missing field `platform`" }),
  guild: z.string({ error: "missing field `guild`" }),
});

async function mappings(state: ApiState, c: ApiContext): Promise<Response> {
  const q = readQuery(c, MappingsQuerySchema);
  const platform = q.platform.trim();
  const guild = q.guild.trim();
  const service = state.optional(AuthServiceKey);
  if (service) return json(await service.mappings(platform, guild));
  const store = state.service(AuthStoreKey, "auth store");
  return json(await store.mappings(platform, guild));
}

const RoleMappingSchema = z.object({
  platform: z.string(),
  guild: z.string(),
  platform_role: z.string(),
  role: z.string(),
});

async function setMapping(state: ApiState, c: ApiContext): Promise<Response> {
  const mapping = await readJson(c, RoleMappingSchema);
  if (mapping.guild.trim() === "" || mapping.platform_role.trim() === "") {
    throw ApiError.badRequest("`guild` and `platform_role` must not be empty");
  }
  const service = auth(state);
  if (!service.role(mapping.role)) throw unknownRole(mapping.role);
  try {
    await service.mapRole(actorOf(c), { ...mapping });
  } catch (error) {
    throw ApiError.internal(error);
  }
  return json(mapping);
}

const RemoveMappingSchema = z.object({
  platform: z.string(),
  guild: z.string(),
  platform_role: z.string(),
});

async function removeMapping(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, RemoveMappingSchema);
  const service = auth(state);
  let removed: boolean;
  try {
    removed = await service.unmapRole(
      actorOf(c),
      request.platform,
      request.guild,
      request.platform_role,
    );
  } catch (error) {
    throw ApiError.internal(error);
  }
  if (!removed) throw ApiError.notFound("no such role mapping");
  return noContent();
}

export function roleRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/auth/roles", handler: () => roles(state) },
    { method: "GET", path: "/api/auth/roles/:name", handler: (c) => role(state, c) },
    { method: "PUT", path: "/api/auth/roles/:name", handler: (c) => upsertRole(state, c) },
    { method: "DELETE", path: "/api/auth/roles/:name", handler: (c) => deleteRole(state, c) },
    { method: "GET", path: "/api/auth/assignments", handler: () => assignments(state) },
    { method: "POST", path: "/api/auth/assignments", handler: (c) => assign(state, c) },
    { method: "DELETE", path: "/api/auth/assignments", handler: (c) => revoke(state, c) },
    { method: "GET", path: "/api/auth/mappings", handler: (c) => mappings(state, c) },
    { method: "PUT", path: "/api/auth/mappings", handler: (c) => setMapping(state, c) },
    { method: "DELETE", path: "/api/auth/mappings", handler: (c) => removeMapping(state, c) },
  ];
}
