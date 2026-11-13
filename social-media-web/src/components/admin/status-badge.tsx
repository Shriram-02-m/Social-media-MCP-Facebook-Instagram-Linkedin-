// Single source for the shared status badges. The concrete implementations
// live in src/components/status-badge.tsx so both the admin panel and the
// user workspace import the same component.

export {
  PostStatusBadge,
  SocialStatusBadge,
  UserStatusBadge,
} from "@/components/status-badge";
