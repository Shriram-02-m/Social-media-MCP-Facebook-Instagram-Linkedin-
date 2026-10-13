export type Platform = "instagram" | "facebook" | "linkedin";
export type MetaPlatform = Extract<Platform, "instagram" | "facebook">;

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  instagramAccount?: { id: string; username?: string };
}

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  connectedAt: number;
  accountId?: string;
  accountName?: string;
  pages?: MetaPage[];
}

export interface LinkedInPost {
  id?: string;
  author?: string;
  commentary?: string;
  createdAt?: number;
  publishedAt?: number;
  lifecycleState?: string;
}

export type TokenVault = Partial<Record<Platform, StoredToken>>;

export interface PublishedPost {
  platform: Platform;
  id: string;
  url?: string;
  confirmed: true;
}