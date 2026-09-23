"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation, ContactTag } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  /**
   * Fired on contact_tags INSERT / UPDATE / DELETE. Lets the Inbox refresh
   * a conversation's embedded `contact.tags` the moment a tag is assigned
   * or removed anywhere (sidebar, contacts page, automations, API) without
   * waiting for a manual refetch.
   */
  onContactTagEvent?: (event: RealtimeEvent<ContactTag>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  onContactTagEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  const onContactTagRef = useRef(onContactTagEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
    onContactTagRef.current = onContactTagEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    let channel: RealtimeChannel | undefined;

    const register = (ch: RealtimeChannel) => {
      ch.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "conversations" },
          (payload) => {
            onConversationRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
              new: payload.new as Conversation,
              old: payload.old as Partial<Conversation>,
            });
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "contact_tags" },
          (payload) => {
            onContactTagRef.current?.({
              eventType: payload.eventType as RealtimeEvent<ContactTag>["eventType"],
              new: payload.new as ContactTag,
              old: payload.old as Partial<ContactTag>,
            });
          }
        );
    };

    const buildAndSubscribe = () => {
      channel = supabase.channel(channelName);
      register(channel);
      channel.subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });
      channelRef.current = channel;
    };

    buildAndSubscribe();

    // Mobile / background-tab safety net: a tab that sat backgrounded
    // (browser throttles the WS, or it dropped while the phone slept)
    // may be left on a dead channel with no way to know. When the tab
    // comes back, check the channel health and rebuild+resubscribe if it
    // no longer reports joined. The parent still bumps a resyncToken on
    // these same events to refetch anything lost in the gap — rebuilding
    // here just guarantees the pipe itself is live again.
    const resyncIfNeeded = () => {
      const current = channelRef.current;
      if (current && current.state !== "joined") {
        supabase.removeChannel(current);
        buildAndSubscribe();
      }
    };
    const onDocumentVisible = () => {
      if (document.visibilityState === "visible") resyncIfNeeded();
    };
    const onWindowFocus = () => resyncIfNeeded();
    const onOnline = () => resyncIfNeeded();
    const onPageShow = () => resyncIfNeeded();

    document.addEventListener("visibilitychange", onDocumentVisible);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onDocumentVisible);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
      const current = channelRef.current ?? channel;
      if (current) supabase.removeChannel(current);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
