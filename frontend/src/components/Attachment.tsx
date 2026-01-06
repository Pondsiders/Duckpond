/**
 * Attachment components for image uploads.
 *
 * Gives Alpha eyes! Allows pasting/dragging images into the composer.
 */

import { FC } from "react";
import {
  ComposerPrimitive,
  MessagePrimitive,
  AttachmentPrimitive,
  useAttachment,
} from "@assistant-ui/react";
import { Paperclip, X, ImageIcon } from "lucide-react";
import { colors } from "../theme";

// -----------------------------------------------------------------------------
// Composer attachment (with remove button)
// -----------------------------------------------------------------------------

const ComposerAttachment: FC = () => {
  const attachment = useAttachment();

  // Try to get image URL from the attachment
  let imageUrl: string | undefined;
  if (attachment.type === "image") {
    // For pending attachments, we might have a file we can preview
    if ("file" in attachment && attachment.file) {
      imageUrl = URL.createObjectURL(attachment.file);
    }
    // For complete attachments, check content
    if ("content" in attachment && attachment.content) {
      const imageContent = attachment.content.find(
        (c): c is { type: "image"; image: string } => c.type === "image"
      );
      if (imageContent) {
        imageUrl = imageContent.image;
      }
    }
  }

  return (
    <AttachmentPrimitive.Root
      style={{
        position: "relative",
        width: "64px",
        height: "64px",
        borderRadius: "8px",
        overflow: "hidden",
        background: colors.surface,
        border: `1px solid ${colors.border}`,
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={attachment.name}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.muted,
          }}
        >
          <ImageIcon size={24} />
        </div>
      )}
      <AttachmentPrimitive.Remove
        style={{
          position: "absolute",
          top: "-6px",
          right: "-6px",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          background: colors.primary,
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: "white",
        }}
      >
        <X size={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

// -----------------------------------------------------------------------------
// ComposerAttachments — renders all pending attachments
// -----------------------------------------------------------------------------

export const ComposerAttachments: FC = () => {
  return (
    <ComposerPrimitive.Attachments
      components={{ Attachment: ComposerAttachment }}
    />
  );
};

// -----------------------------------------------------------------------------
// ComposerAddAttachment — the "+" button to add images
// -----------------------------------------------------------------------------

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment
      style={{
        width: "36px",
        height: "36px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: `1px solid ${colors.border}`,
        borderRadius: "8px",
        color: colors.muted,
        cursor: "pointer",
      }}
      title="Add image"
    >
      <Paperclip size={18} />
    </ComposerPrimitive.AddAttachment>
  );
};

// -----------------------------------------------------------------------------
// UserMessageAttachments — renders attachments in sent messages
// -----------------------------------------------------------------------------

const MessageAttachment: FC = () => {
  const attachment = useAttachment();

  // Get image URL from attachment content
  let imageUrl: string | undefined;
  if (attachment.type === "image" && "content" in attachment && attachment.content) {
    const imageContent = attachment.content.find(
      (c): c is { type: "image"; image: string } => c.type === "image"
    );
    if (imageContent) {
      imageUrl = imageContent.image;
    }
  }

  return (
    <div
      style={{
        width: "120px",
        height: "120px",
        borderRadius: "8px",
        overflow: "hidden",
        background: colors.surface,
        border: `1px solid ${colors.border}`,
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={attachment.name}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.muted,
          }}
        >
          <ImageIcon size={32} />
        </div>
      )}
    </div>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        marginBottom: "8px",
      }}
    >
      <MessagePrimitive.Attachments
        components={{ Attachment: MessageAttachment }}
      />
    </div>
  );
};
