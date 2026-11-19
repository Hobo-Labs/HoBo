import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { type AuthUser } from "wasp/auth";
import { useAuth } from "wasp/client/auth";
import { saveAdminProfile } from "wasp/client/operations";
import * as z from "zod";
import { Button } from "../../../client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../client/components/ui/card";
import { Input } from "../../../client/components/ui/input";
import { Label } from "../../../client/components/ui/label";
import { Textarea } from "../../../client/components/ui/textarea";
import { Breadcrumb } from "../../layout/Breadcrumb";
import { DefaultLayout } from "../../layout/DefaultLayout";

const maxPhotoBytes = 256 * 1024;

type Profile = {
  fullName: string | null;
  phoneNumber: string | null;
  bio: string | null;
  profilePhoto: string | null;
};

export function SettingsPage({ user }: { user: AuthUser }) {
  const { refetch: refetchAuth } = useAuth();
  const photoReadGeneration = useRef(0);
  const activePhotoReader = useRef<FileReader | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [layoutUser, setLayoutUser] = useState(user);
  const [saved, setSaved] = useState<Profile>({
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    bio: user.bio,
    profilePhoto: user.profilePhoto,
  });
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function clearPhotoFileInput() {
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
  }

  function cancelPhotoRead() {
    photoReadGeneration.current += 1;
    activePhotoReader.current?.abort();
    activePhotoReader.current = null;
    setReadingPhoto(false);
  }

  function changePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    clearPhotoFileInput();
    cancelPhotoRead();
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > maxPhotoBytes
    ) {
      setError("Choose a PNG, JPEG, or WebP image no larger than 256 KB.");
      return;
    }
    const generation = photoReadGeneration.current;
    const reader = new FileReader();
    activePhotoReader.current = reader;
    setReadingPhoto(true);
    setError("");
    setNotice("");
    reader.onerror = () => {
      if (generation !== photoReadGeneration.current) return;
      activePhotoReader.current = null;
      setReadingPhoto(false);
      setError("The image could not be read.");
    };
    reader.onload = () => {
      if (generation !== photoReadGeneration.current) return;
      activePhotoReader.current = null;
      setReadingPhoto(false);
      const result = z.string().safeParse(reader.result);
      if (!result.success) {
        setError("The image could not be read.");
        return;
      }
      setDraft((current) => ({ ...current, profilePhoto: result.data }));
      setError("");
      setNotice("");
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readingPhoto || saving) {
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const profile = await saveAdminProfile({
        fullName: draft.fullName ?? "",
        phoneNumber: draft.phoneNumber ?? "",
        bio: draft.bio ?? "",
        profilePhoto: draft.profilePhoto,
      });
      setSaved(profile);
      setDraft(profile);
      setLayoutUser((current) => ({ ...current, ...profile }));
      setNotice("Settings saved.");
      void refetchAuth();
    } catch {
      setError("Settings could not be saved. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DefaultLayout user={layoutUser}>
      <div className="mx-auto max-w-4xl">
        <Breadcrumb pageName="Settings" />
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-6"
        >
          <Card>
            <CardHeader>
              <CardTitle>Personal information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="full-name">Full name</Label>
                  <Input
                    id="full-name"
                    maxLength={100}
                    value={draft.fullName ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        fullName: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone-number">Phone number</Label>
                  <Input
                    id="phone-number"
                    type="tel"
                    maxLength={40}
                    value={draft.phoneNumber ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        phoneNumber: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="email-address">Email address</Label>
                  <Input id="email-address" value={user.email ?? ""} readOnly />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input id="username" value={user.username ?? ""} readOnly />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  rows={5}
                  maxLength={1000}
                  value={draft.bio ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bio: event.target.value,
                    }))
                  }
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Profile photo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.profilePhoto && (
                <img
                  className="h-20 w-20 rounded-full object-cover"
                  src={draft.profilePhoto}
                  alt="Profile preview"
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="profile-photo">Choose a photo</Label>
                <Input
                  ref={photoInputRef}
                  id="profile-photo"
                  type="file"
                  disabled={saving || readingPhoto}
                  accept="image/png,image/jpeg,image/webp"
                  onChange={changePhoto}
                />
                <p className="text-muted-foreground text-sm">
                  PNG, JPEG, or WebP, up to 256 KB.
                </p>
              </div>
              {draft.profilePhoto && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving || readingPhoto}
                  onClick={() => {
                    cancelPhotoRead();
                    clearPhotoFileInput();
                    setDraft((current) => ({ ...current, profilePhoto: null }));
                  }}
                >
                  Remove photo
                </Button>
              )}
            </CardContent>
          </Card>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={saving || readingPhoto}
              onClick={() => {
                cancelPhotoRead();
                clearPhotoFileInput();
                setDraft(saved);
                setError("");
                setNotice("");
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || readingPhoto}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      </div>
    </DefaultLayout>
  );
}
