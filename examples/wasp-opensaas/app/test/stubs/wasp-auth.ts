export type AuthUser = {
  id: string;
  isAdmin: boolean;
  email?: string | null;
  username?: string | null;
  fullName?: string | null;
  phoneNumber?: string | null;
  bio?: string | null;
  profilePhoto?: string | null;
};