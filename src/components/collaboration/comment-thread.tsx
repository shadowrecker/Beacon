"use client";

import { useState } from "react";
import type { CommentTargetType } from "@prisma/client";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Pencil, Reply, Trash2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/team/confirm-dialog";
import { MemberAvatar } from "@/components/team/member-list";
import { CommentComposer } from "./comment-composer";
import { CommentContent, tokensToEditable } from "./comment-content";

type Thread = RouterOutputs["collaboration"]["getComments"]["items"][number];
type CommentItem = Omit<Thread, "replies" | "replyCount">;

export interface CommentThreadProps {
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
}

/** Threaded comments with @mentions for any comment target in a project. */
export function CommentThread({ projectId, targetType, targetId }: CommentThreadProps) {
  const utils = trpc.useUtils();
  const input = { projectId, targetType, targetId, limit: 20 };
  const comments = trpc.collaboration.getComments.useInfiniteQuery(input, {
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const add = trpc.collaboration.addComment.useMutation();
  const edit = trpc.collaboration.editComment.useMutation();
  const remove = trpc.collaboration.deleteComment.useMutation();
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CommentItem | null>(null);

  const refresh = () => utils.collaboration.getComments.invalidate({ projectId, targetType, targetId });
  const threads = comments.data?.pages.flatMap((p) => p.items) ?? [];
  const canComment = comments.data?.pages[0]?.canComment ?? false;

  const submitNew = async (content: string, parentId?: string) => {
    try {
      await add.mutateAsync({ projectId, targetType, targetId, content, parentId });
    } catch {
      return false; // surfaced by the global error toast
    }
    setReplyTo(null);
    await refresh();
    return true;
  };

  const submitEdit = async (commentId: string, content: string) => {
    try {
      await edit.mutateAsync({ projectId, commentId, content });
    } catch {
      return false;
    }
    setEditing(null);
    toast.success("Comment updated");
    await refresh();
    return true;
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync({ projectId, commentId: deleting.id });
    } catch {
      return;
    }
    setDeleting(null);
    toast.success("Comment deleted");
    await refresh();
  };

  const renderComment = (c: CommentItem, opts: { rootId: string; isReply: boolean }) => {
    const isEditing = editing === c.id;
    const editable = isEditing ? tokensToEditable(c.content, c.mentions) : null;
    return (
      <div className="flex gap-3">
        <MemberAvatar name={c.author.name} avatarUrl={c.author.avatarUrl} size={opts.isReply ? "h-7 w-7" : "h-8 w-8"} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm">
            <span className="font-medium">{c.author.name}</span>{" "}
            <time className="text-xs text-muted-foreground" dateTime={new Date(c.createdAt).toISOString()}>
              {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
            </time>
            {c.edited && <span className="text-xs text-muted-foreground"> · edited</span>}
          </p>
          {isEditing && editable ? (
            <CommentComposer
              projectId={projectId}
              label="Edit comment"
              submitLabel="Save"
              initialText={editable.text}
              initialMentions={editable.mentions}
              pending={edit.isPending}
              autoFocus
              onSubmit={(content) => submitEdit(c.id, content)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <CommentContent content={c.content} mentions={c.mentions} />
          )}
          {!isEditing && (
            <div className="flex gap-1">
              {canComment && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setReplyTo(opts.rootId)}>
                  <Reply className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Reply
                </Button>
              )}
              {c.canEdit && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(c.id)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Edit
                </Button>
              )}
              {c.canDelete && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setDeleting(c)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <section aria-label="Comments" className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <MessageSquare className="h-4 w-4" aria-hidden />
        Comments
      </h3>

      {comments.isLoading ? (
        <LoadingState rows={2} label="Loading comments" />
      ) : comments.isError ? (
        <ErrorState message={comments.error.message} onRetry={() => void comments.refetch()} />
      ) : (
        <>
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.{canComment ? " Start the discussion below." : ""}</p>
          ) : (
            <ol className="space-y-5">
              {threads.map((t) => (
                <li key={t.id} className="space-y-3">
                  {renderComment(t, { rootId: t.id, isReply: false })}
                  {(t.replies.length > 0 || replyTo === t.id) && (
                    <ol className="ml-11 space-y-3 border-l pl-4">
                      {t.replies.map((r) => (
                        <li key={r.id}>{renderComment(r, { rootId: t.id, isReply: true })}</li>
                      ))}
                      {t.replyCount > t.replies.length && (
                        <li className="text-xs text-muted-foreground">
                          Showing the first {t.replies.length} of {t.replyCount} replies.
                        </li>
                      )}
                      {replyTo === t.id && (
                        <li>
                          <CommentComposer
                            projectId={projectId}
                            label={`Reply to ${t.author.name}`}
                            placeholder={`Reply to ${t.author.name}…`}
                            submitLabel="Reply"
                            pending={add.isPending}
                            autoFocus
                            onSubmit={(content) => submitNew(content, t.id)}
                            onCancel={() => setReplyTo(null)}
                          />
                        </li>
                      )}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          )}

          {comments.hasNextPage && (
            <Button variant="outline" size="sm" onClick={() => void comments.fetchNextPage()} disabled={comments.isFetchingNextPage}>
              {comments.isFetchingNextPage ? "Loading…" : "Show more comments"}
            </Button>
          )}

          {canComment ? (
            <CommentComposer
              projectId={projectId}
              label="Add a comment"
              submitLabel="Comment"
              pending={add.isPending && !replyTo}
              onSubmit={(content) => submitNew(content)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">You have view-only access, so you can read but not add comments.</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title="Delete this comment?"
        description={
          <p>{deleting && !deleting.parentId ? "Replies to it will be deleted too. " : ""}This can&apos;t be undone.</p>
        }
        confirmLabel="Delete comment"
        destructive
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
