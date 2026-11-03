import { z } from 'zod';
import type { GatewayInbound, GatewayWhatsAppIdentities } from '../../shared/types.ts';
import { canonicalWhatsAppPhone } from '../../shared/gateway-whatsapp.ts';

const id = z.string().min(1).max(500);
const stamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const whatsAppIdentitiesSchema: z.ZodType<GatewayWhatsAppIdentities> = z.strictObject({
  businessAccountId: z.string().regex(/^[1-9]\d{0,29}$/),
  users: z.array(z.strictObject({ id, phone: z.string().refine(canonicalWhatsAppPhone).nullable(), at: stamp, retired: z.boolean(), parentId: id.optional() })).max(10000),
  phoneChanges: z.array(z.strictObject({ phone: z.string().refine(canonicalWhatsAppPhone), at: stamp })).max(10000),
}).refine((value) => new Set(value.users.map((user) => user.id)).size === value.users.length
  && new Set(value.phoneChanges.map((change) => change.phone)).size === value.phoneChanges.length);

export function whatsAppIdentityAllowed(input: GatewayInbound, state: GatewayWhatsAppIdentities | undefined): boolean {
  if (input.platform !== 'whatsapp') return input.whatsappUserId === undefined;
  if (state?.phoneChanges.some((change) => change.phone === input.actor.id && (input.sentAt ?? 0) <= change.at)) return false;
  if (!input.whatsappUserId) return true;
  const user = state?.users.find((item) => item.id === input.whatsappUserId);
  return Boolean(user && !user.retired && user.phone === input.actor.id);
}

/** Mutates only the caller's journal snapshot. The inbox commits it with the whole batch. */
export class WhatsAppIdentities {
  readonly state: GatewayWhatsAppIdentities;
  constructor(businessAccountId: string, saved?: GatewayWhatsAppIdentities) {
    this.state = whatsAppIdentitiesSchema.parse(saved ?? { businessAccountId, users: [], phoneChanges: [] });
    if (this.state.businessAccountId !== businessAccountId) throw new Error('The WhatsApp business account changed. Review setup before reconnecting.');
  }

  private create(user: GatewayWhatsAppIdentities['users'][number]): void {
    if (this.state.users.length >= 10000) throw new Error('The WhatsApp identity store is full. Review it before reconnecting.');
    this.state.users.push(user);
  }

  private changedPhone(phone: string | null, at: number): void {
    if (!phone) return;
    const change = this.state.phoneChanges.find((item) => item.phone === phone);
    if (change) change.at = Math.max(at, change.at);
    else {
      if (this.state.phoneChanges.length >= 10000) throw new Error('The WhatsApp identity store is full. Review it before reconnecting.');
      this.state.phoneChanges.push({ phone, at });
    }
  }

  conflict(userId: string | undefined, at: number): void {
    const user = this.state.users.find((item) => item.id === userId);
    if (user && at >= user.at) { this.changedPhone(user.phone, at); user.retired = true; }
  }

  /** A normal signed message can establish an alias, but cannot move one to a different phone. */
  resolve(userId: string | undefined, phone: string | null, at: number, parentId?: string): string | null {
    if (!userId) return phone;
    const user = this.state.users.find((item) => item.id === userId);
    if (user?.retired) return null;
    if (!user) {
      if (!phone || this.state.phoneChanges.some((change) => change.phone === phone && at <= change.at)) return null;
      this.create({ id: userId, phone, at, retired: false, ...(parentId ? { parentId } : {}) });
      return phone;
    }
    if (phone && user.phone && phone !== user.phone) {
      // A conflicting alias never transfers the old phone's permission, even if both are allowed.
      this.conflict(user.id, at);
      return null;
    }
    if (!user.phone && phone) {
      if (at <= user.at || this.state.phoneChanges.some((change) => change.phone === phone && at <= change.at)) return null;
      user.phone = phone;
    }
    if (at > user.at) { user.at = at; if (parentId) user.parentId = parentId; }
    return user.phone;
  }

  /** Missing new phone proof clears authorization; previous aliases remain durable tombstones. */
  rotate(previous: string | undefined, current: string | undefined, phone: string | null, at: number,
    options: { oldPhone?: string | null; previousParent?: string; currentParent?: string } = {}): void {
    if ((!previous && !current && !options.oldPhone && !options.previousParent) || (previous && previous === current)) throw new Error('The WhatsApp identity update is incomplete. Review it before reconnecting.');
    this.changedPhone(options.oldPhone ?? null, at);
    for (const user of this.state.users) {
      if (user.id !== previous && !(options.oldPhone && user.phone === options.oldPhone) && !(options.previousParent && user.parentId === options.previousParent)) continue;
      // A delayed system notice cannot revoke a newer, independently verified phone association.
      if (user.id !== previous && user.at > at) continue;
      this.changedPhone(user.phone, at); user.at = Math.max(user.at, at); user.retired = true;
    }
    if (previous && !this.state.users.some((user) => user.id === previous)) this.create({ id: previous, phone: null, at, retired: true });
    if (!current) return;
    const user = this.state.users.find((item) => item.id === current);
    if (user) {
      if (user.retired || user.at > at) return;
      if (user.phone && phone && user.phone !== phone) { this.conflict(user.id, at); return; }
      if (user.phone && !phone) this.changedPhone(user.phone, at);
      user.phone = phone; user.at = at;
      if (options.currentParent) user.parentId = options.currentParent;
    } else this.create({ id: current, phone, at, retired: false, ...(options.currentParent ? { parentId: options.currentParent } : {}) });
  }
}
