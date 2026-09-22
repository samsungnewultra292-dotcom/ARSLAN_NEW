"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Video as VideoIcon,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { CHAT_MEDIA_BUCKET } from "@/components/inbox/message-composer";
import type { QuickReply, QuickReplyKind } from "@/types";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
  media_url?: string;
  media_name?: string;
  media_path?: string;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
  };
}

export function QuickRepliesManager() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  // Pending video object created for the open draft — GC'd if the dialog
  // closes without saving so an abandoned upload doesn't orphan in the
  // bucket. Saved snippets keep their object forever.
  const draftRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    draftRef.current = null;
    setDraft(emptyDraft());
  };
  const openEdit = (qr: QuickReply) => {
    draftRef.current = null;
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
      media_url: qr.media_url ?? undefined,
      media_name: qr.media_name ?? undefined,
      media_path: qr.media_path ?? undefined,
    });
  };

  const closeDraft = () => {
    if (draftRef.current) {
      void deleteAccountMedia(CHAT_MEDIA_BUCKET, draftRef.current).catch(() => {});
    }
    draftRef.current = null;
    setDraft(null);
  };

  // Upload a video into chat-media and stage it on the draft. The stored
  // object is never GC'd — the snippet is the durable owner of the media.
  const stageVideo = useCallback(async (file: File) => {
    const max = MEDIA_MAX_BYTES_BY_KIND.video;
    if (file.size > max) {
      toast.error(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — video limit is ${Math.round(
          max / 1024 / 1024,
        )} MB.`,
      );
      return;
    }
    setUploading(true);
    try {
      const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      // GC any object a previous video on this draft pointed to.
      if (draftRef.current) {
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, draftRef.current).catch(() => {});
      }
      draftRef.current = path;
      setDraft((d) =>
        d
          ? {
              ...d,
              kind: "video",
              media_url: publicUrl,
              media_name: file.name,
              media_path: path,
            }
          : d,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error("Give the quick reply a name.");
      return;
    }
    if (draft.kind === "video" && !draft.media_url) {
      toast.error("Upload the video first.");
      return;
    }
    const payload =
      draft.kind === "interactive"
        ? { title: draft.title, kind: "interactive", interactive_payload: draft.interactive_payload }
        : draft.kind === "video"
          ? {
              title: draft.title,
              kind: "video",
              media_url: draft.media_url,
              media_name: draft.media_name,
              media_type: "video/mp4",
              media_path: draft.media_path,
            }
          : { title: draft.title, kind: "text", content_text: draft.content_text };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the quick reply.");
        return;
      }
      toast.success(draft.id ? "Quick reply updated." : "Quick reply created.");
      // The video object now belongs to the saved snippet — don't GC it.
      draftRef.current = null;
      setDraft(null);
      await load();
    } catch {
      toast.error("Couldn't save the quick reply.");
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this quick reply?")) return;
      const target = items.find((qr) => qr.id === id);
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Couldn't delete the quick reply.");
        return;
      }
      // The snippet owned its video object — GC it now that no row needs it.
      if (target?.kind === "video" && target.media_path) {
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, target.media_path).catch(() => {});
      }
      await load();
    },
    [load, items],
  );

  return (
    <div>
      <SettingsPanelHead
        title="Quick replies"
        description="Reusable snippets — plain text or a saved interactive message — that agents can insert from the inbox composer."
        action={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            New quick reply
          </Button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No quick replies yet. Create one to reuse it across conversations.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : qr.kind === "video" ? (
                <VideoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qr.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {qr.kind === "interactive" && qr.interactive_payload
                    ? interactivePayloadPreviewText(qr.interactive_payload)
                    : qr.kind === "video"
                      ? qr.media_name || "Video"
                      : qr.content_text}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(qr)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(qr.id)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && closeDraft()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit quick reply" : "New quick reply"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Name</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="e.g. Business hours"
                  className="bg-muted text-foreground"
                />
              </div>
              <div className="flex gap-2">
                <KindTab
                  active={draft.kind === "text"}
                  label="Text"
                  onClick={() => setDraft({ ...draft, kind: "text" })}
                />
                <KindTab
                  active={draft.kind === "interactive"}
                  label="Interactive"
                  onClick={() => setDraft({ ...draft, kind: "interactive" })}
                />
                <KindTab
                  active={draft.kind === "video"}
                  label="Video"
                  onClick={() => setDraft({ ...draft, kind: "video" })}
                />
              </div>
              {draft.kind === "text" ? (
                <Textarea
                  value={draft.content_text}
                  onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                  placeholder="The message text to insert"
                  className="min-h-28 bg-muted text-foreground"
                />
              ) : draft.kind === "video" ? (
                <div className="space-y-2">
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/mp4,video/3gpp"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) void stageVideo(e.target.files[0]);
                      e.target.value = "";
                    }}
                  />
                  {draft.media_url ? (
                    <video
                      src={draft.media_url}
                      controls
                      className="max-h-52 rounded-lg border border-border"
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                      {draft.media_name ? `Staged: ${draft.media_name}` : "No video attached yet."}
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => videoInputRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : draft.media_url ? (
                      <Clapperboard className="mr-1 h-4 w-4" />
                    ) : (
                      <Upload className="mr-1 h-4 w-4" />
                    )}
                    {draft.media_url ? "Replace video" : "Upload video"}
                  </Button>
                  <input
                    value={draft.content_text}
                    onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                    placeholder="Optional caption shown with the video"
                    className="w-full rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
                  />
                </div>
              ) : (
                <InteractiveBuilder
                  value={draft.interactive_payload}
                  onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDraft} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KindTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
          : "flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}
