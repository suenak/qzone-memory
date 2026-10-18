<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { describeError } from "../utils/uiError";
import {
  CalendarDays,
  CircleAlert,
  Clock,
  Heart,
  MessageCircle,
  RefreshCw,
  Search,
  Users,
  UserRound,
} from "lucide-vue-next";
import Button from "primevue/button";
import Drawer from "primevue/drawer";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import QzoneText from "../components/QzoneText.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import SectionCard from "../components/ui/SectionCard.vue";
import ArchiveHeading from "../components/ui/ArchiveHeading.vue";
import SkeletonBlock from "../components/ui/SkeletonBlock.vue";
import StatTile from "../components/ui/StatTile.vue";
import { listContactCommentThreads, listInteractors, type ArchiveItem, type Interactor } from "../utils/qzone";

const contacts = ref<Interactor[]>([]);
const loading = ref(false);
const error = ref("");
const query = ref("");
const sortBy = ref<"total" | "likes" | "comments" | "lastAt">("total");
const selectedContact = ref<Interactor>();
const commentThreads = ref<ArchiveItem[]>([]);
const commentsVisible = ref(false);
const commentsLoading = ref(false);
const commentsError = ref("");
let commentSequence = 0;
let loadSequence = 0;
let disposed = false;

type SortOption = { label: string; value: typeof sortBy.value };
const sortOptions: SortOption[] = [
  { label: "互动最多", value: "total" },
  { label: "点赞最多", value: "likes" },
  { label: "评论最多", value: "comments" },
  { label: "最近互动", value: "lastAt" },
];

const filtered = computed(() => {
  const key = query.value.trim().toLowerCase();
  let list = contacts.value;
  if (key) {
    list = list.filter(
      (c) => c.nickname?.toLowerCase().includes(key) || c.uin.includes(key),
    );
  }
  return [...list].sort((a, b) => {
    switch (sortBy.value) {
      case "likes":
        return b.likes - a.likes || b.total - a.total;
      case "comments":
        return b.comments - a.comments || b.total - a.total;
      case "lastAt":
        return b.lastAt - a.lastAt;
      default:
        return b.total - a.total;
    }
  });
});

const formatTime = (seconds: number) =>
  seconds
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(
        new Date(seconds * 1000),
      )
    : "";

async function openComments(contact: Interactor) {
  if (disposed) return;
  const sequence = ++commentSequence;
  selectedContact.value = contact;
  commentsVisible.value = true;
  commentsLoading.value = true;
  commentsError.value = "";
  commentThreads.value = [];
  try {
    const items = await listContactCommentThreads(contact.uin);
    if (sequence === commentSequence) commentThreads.value = items;
  } catch (reason) {
    if (sequence === commentSequence) commentsError.value = describeError(reason, "评论记录读取失败，请重试。");
  } finally {
    if (sequence === commentSequence) commentsLoading.value = false;
  }
}

async function load() {
  if (disposed || loading.value) return;
  const sequence = ++loadSequence;
  loading.value = true;
  error.value = "";
  try {
    const result = await listInteractors();
    if (sequence !== loadSequence) return;
    contacts.value = result;
    brokenAvatars.value = {};
  } catch (reason) {
    if (sequence === loadSequence) error.value = String(reason);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

onMounted(load);

/* ------------------------------------------------------- 以下仅用于呈现（纯 UI 状态） */

/** 每次渲染的人数，滚到底部再追加，避免一次挂载整张名单。 */
const PAGE_SIZE = 24;
const visibleCount = ref(PAGE_SIZE);
const brokenAvatars = ref<Record<string, boolean>>({});
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;

const searchKey = computed(() => query.value.trim().toLowerCase());
/** 只有「按互动总量排序且未搜索」时，排名才代表「陪你最多的人」。 */
const emphasizing = computed(() => sortBy.value === "total" && searchKey.value === "");
const ranked = computed(() => filtered.value.map((contact, rank) => ({ contact, rank: rank + 1 })));
const visibleContacts = computed(() => ranked.value.slice(0, visibleCount.value));
const hasMore = computed(() => ranked.value.length > visibleCount.value);
const totalInteractions = computed(() => contacts.value.reduce((sum, item) => sum + item.total, 0));
const latestInteraction = computed(() => contacts.value.reduce((latest, item) => Math.max(latest, item.lastAt), 0));
const drawerTitle = computed(
  () => `${selectedContact.value?.nickname || selectedContact.value?.uin || "联系人"} · 评论往来`,
);
const emptyReason = computed(() =>
  error.value
    ? "联系人读取失败，请重试。"
    : "备份说说后，这里会列出有过点赞或评论的人。",
);

/** QQ 头像域名对 referer 敏感，必须带 no-referrer；失败后回退到首字占位。 */
const avatarUrl = (uin: string) => `https://qlogo2.store.qq.com/qzone/${uin}/${uin}/50`;
const avatarKey = (scope: "u" | "c", uin?: string) => `${scope}:${uin ?? ""}`;
const isBroken = (key: string) => Boolean(brokenAvatars.value[key]);

function markBroken(key: string) {
  brokenAvatars.value[key] = true;
}

function initialOf(contact: Interactor) {
  const source = (contact.nickname || contact.uin || "").trim();
  return source ? source.slice(0, 1).toUpperCase() : "?";
}

function avatarClass(rank: number) {
  if (!emphasizing.value) return "is-base";
  if (rank === 1) return "is-hero";
  if (rank <= 3) return "is-strong";
  return "is-base";
}

function observeSentinel() {
  observer?.disconnect();
  if (disposed || !observer || !sentinel.value || !hasMore.value) return;
  observer.observe(sentinel.value);
}

function showMore() {
  if (disposed || !hasMore.value) return;
  visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, ranked.value.length);
}

watch([searchKey, sortBy], () => {
  visibleCount.value = PAGE_SIZE;
});

// The sentinel can be replaced while hasMore stays true, such as after search.
// Re-arm after each batch too, so a tall viewport can fill beyond one batch.
watch([sentinel, visibleCount, hasMore], observeSentinel, { flush: "post" });
watch(commentsVisible, (visible) => {
  if (visible) return;
  ++commentSequence;
  commentsLoading.value = false;
  commentsError.value = "";
  commentThreads.value = [];
  selectedContact.value = undefined;
}, { flush: "sync" });

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.target === sentinel.value)) showMore();
    },
    { rootMargin: "160px" },
  );
  observeSentinel();
});

onBeforeUnmount(() => {
  disposed = true;
  ++loadSequence;
  ++commentSequence;
  observer?.disconnect();
  observer = undefined;
});
</script>

<template>
  <div class="qzc-page">
    <ArchiveHeading title="联系人" description="查看备份中与你有过点赞或评论互动的人。" :icon="Users" />
    <div class="qzc-stats">
      <StatTile
        label="互动过的联系人"
        :value="error ? '—' : contacts.length"
        hint="出现在点赞与评论记录里的人"
        :icon="Users"
        tone="accent"
        :loading="loading && !contacts.length"
      />
      <StatTile
        label="互动总次数"
        :value="error ? '—' : totalInteractions"
        hint="点赞与评论合计"
        :icon="MessageCircle"
        tone="warm"
        :loading="loading && !contacts.length"
      />
      <StatTile
        label="最近一次互动"
        :value="error ? '—' : latestInteraction ? formatTime(latestInteraction) : '暂无记录'"
        hint="取自本地备份的互动时间"
        :icon="Clock"
        tone="neutral"
        :loading="loading && !contacts.length"
      />
    </div>

    <SectionCard
      title="互动联系人"
      description="点击联系人查看评论记录。"
    >
      <template #actions>
        <Button label="刷新" severity="secondary" text :loading="loading" @click="load">
          <template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template>
        </Button>
      </template>

      <div class="qzc-toolbar">
        <label class="qzc-search">
          <Search :size="15" :stroke-width="1.8" aria-hidden="true" />
          <InputText
            v-model="query"
            class="qzc-search__input"
            placeholder="搜索昵称或 QQ 号"
            aria-label="搜索联系人"
          />
        </label>
        <span class="qzc-sort">
          <Select
            v-model="sortBy"
            :options="sortOptions"
            option-label="label"
            option-value="value"
            aria-label="排序方式"
          />
        </span>
      </div>

      <p v-if="error && contacts.length" class="qzc-alert">
        <CircleAlert :size="15" :stroke-width="1.8" aria-hidden="true" />
        <span>刷新失败，仍显示上次读取的内容。</span>
        <button type="button" class="qzc-alert__retry" @click="load">重试</button>
      </p>

      <div v-if="loading && !contacts.length" class="qzc-grid" aria-busy="true">
        <div v-for="index in 6" :key="`skeleton-${index}`" class="qzc-person is-skeleton">
          <SkeletonBlock width="44px" circle />
          <div class="qzc-person__identity">
            <SkeletonBlock width="72%" height="13px" />
            <SkeletonBlock width="46%" height="11px" />
          </div>
        </div>
      </div>

      <EmptyState
        v-else-if="!contacts.length"
        :icon="error ? CircleAlert : Users"
        :tone="error ? 'danger' : 'warm'"
        :title="error ? '联系人读取失败' : '还没有互动记录'"
        :description="emptyReason"
      >
        <Button v-if="error" label="重试" severity="secondary" @click="load">
          <template #icon><RefreshCw :size="16" :stroke-width="1.8" /></template>
        </Button>
      </EmptyState>

      <EmptyState
        v-else-if="!filtered.length"
        :icon="Search"
        title="没有匹配的联系人"
        :description="`没有人的昵称或 QQ 号包含「${query.trim()}」，换个关键词试试。`"
      >
        <Button label="清除搜索" severity="secondary" text @click="query = ''" />
      </EmptyState>

      <template v-else>
        <div class="qzc-grid">
          <article
            v-for="{ contact, rank } in visibleContacts"
            :key="contact.uin"
            class="qzc-person"
            :class="{ 'is-top': emphasizing && rank <= 3 }"
          >
            <button
              type="button"
              class="qzc-person__hit"
              :title="
                contact.comments
                  ? `查看与 ${contact.nickname || contact.uin} 的评论往来`
                  : '这位联系人只留下了点赞，没有可还原的评论'
              "
              @click="openComments(contact)"
            >
              <span class="qzc-avatar" :class="avatarClass(rank)">
                <img
                  v-if="!isBroken(avatarKey('u', contact.uin))"
                  :src="avatarUrl(contact.uin)"
                  :alt="contact.nickname || contact.uin"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="markBroken(avatarKey('u', contact.uin))"
                />
                <template v-else>{{ initialOf(contact) }}</template>
              </span>

              <span class="qzc-person__identity">
                <span class="qzc-person__name">{{ contact.nickname || contact.uin }}</span>
                <span v-if="contact.nickname && contact.nickname !== contact.uin" class="qzc-person__uin">
                  QQ {{ contact.uin }}
                </span>
              </span>

              <span class="qzc-person__total">
                <strong>{{ contact.total }}</strong>
                <small>次互动</small>
              </span>
            </button>

            <div class="qzc-person__meta">
              <span class="qzc-rank">{{ emphasizing ? `#${rank}` : rank }}</span>
              <span title="点赞数"><Heart :size="13" :stroke-width="1.8" aria-hidden="true" />{{ contact.likes }}</span>
              <span title="评论数">
                <MessageCircle :size="13" :stroke-width="1.8" aria-hidden="true" />{{ contact.comments }}
              </span>
              <span v-if="contact.lastAt" title="最近互动时间">
                <CalendarDays :size="13" :stroke-width="1.8" aria-hidden="true" />{{ formatTime(contact.lastAt) }}
              </span>
            </div>

            <p v-if="emphasizing && rank === 1" class="qzc-person__note">互动次数最多</p>
          </article>
        </div>

        <div v-if="hasMore" ref="sentinel" class="qzc-sentinel">
          <Button label="显示更多联系人" severity="secondary" text @click="showMore" />
        </div>
      </template>

      <template #footer>
        <p class="qzc-foot">
          {{ error ? '联系人数量尚未读取' : `共 ${contacts.length} 位联系人` }}
          <template v-if="filtered.length !== contacts.length">，当前筛选出 {{ filtered.length }} 位</template>
          <template v-if="visibleContacts.length < filtered.length">，已显示 {{ visibleContacts.length }} 位</template>
        </p>
      </template>
    </SectionCard>

    <Drawer
      v-model:visible="commentsVisible"
      position="right"
      :header="drawerTitle"
      :aria-label="drawerTitle"
      class="qzc-drawer"
      style="width: min(560px, 100%)"
    >
      <div v-if="selectedContact" class="qzc-subject">
        <span class="qzc-avatar is-strong">
          <img
            v-if="!isBroken(avatarKey('u', selectedContact.uin))"
            :src="avatarUrl(selectedContact.uin)"
            :alt="selectedContact.nickname || selectedContact.uin"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            @error="markBroken(avatarKey('u', selectedContact.uin))"
          />
          <template v-else>{{ initialOf(selectedContact) }}</template>
        </span>
        <div class="qzc-subject__copy">
          <strong>{{ selectedContact.nickname || selectedContact.uin }}</strong>
          <small>QQ {{ selectedContact.uin }}</small>
          <p>
            共 {{ selectedContact.total }} 次互动 · {{ selectedContact.likes }} 个赞 ·
            {{ selectedContact.comments }} 条评论
            <template v-if="selectedContact.lastAt"> · 最近 {{ formatTime(selectedContact.lastAt) }}</template>
          </p>
        </div>
      </div>

      <div v-if="commentsLoading" class="qzc-threads" aria-busy="true">
        <div v-for="index in 3" :key="`thread-skeleton-${index}`" class="qzc-thread is-skeleton">
          <SkeletonBlock width="40%" height="11px" />
          <SkeletonBlock :lines="2" height="13px" />
        </div>
      </div>

      <EmptyState
        v-else-if="commentsError"
        :icon="CircleAlert"
        tone="danger"
        compact
        title="评论读取失败"
        :description="commentsError"
      >
        <Button label="重试" severity="secondary" size="small" @click="selectedContact && openComments(selectedContact)">
          <template #icon><RefreshCw :size="15" :stroke-width="1.8" /></template>
        </Button>
      </EmptyState>

      <EmptyState
        v-else-if="!commentThreads.length"
        :icon="MessageCircle"
        compact
        title="没有保存的评论"
        :description="selectedContact?.comments ? '部分历史记录只保留了评论次数，没有保留正文。' : '这位联系人只有点赞记录。'"
      />

      <div v-else class="qzc-threads">
        <article v-for="item in commentThreads" :key="item.id" class="qzc-thread">
          <header class="qzc-thread__head">
            <span class="qzc-thread__time">
              <CalendarDays :size="14" :stroke-width="1.8" aria-hidden="true" />
              {{ formatTime(item.publishedAt) || "时间未知" }}
            </span>
            <span class="qzc-thread__count">{{ item.commentCount }} 次评论互动</span>
          </header>

          <p class="qzc-thread__content">
            <QzoneText :value="item.content || '（原说说无文字内容）'" />
          </p>

          <div class="qzc-comments">
            <div
              v-for="comment in item.comments"
              :key="`${comment.uin}-${comment.createdAt}-${comment.content}`"
              class="qzc-comment"
            >
              <span class="qzc-comment__avatar">
                <img
                  v-if="comment.uin && !isBroken(avatarKey('c', comment.uin))"
                  :src="avatarUrl(comment.uin)"
                  :alt="comment.nickname || comment.uin"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="markBroken(avatarKey('c', comment.uin))"
                />
                <UserRound v-else :size="14" :stroke-width="1.8" aria-hidden="true" />
              </span>

              <div class="qzc-comment__body">
                <div class="qzc-comment__meta">
                  <strong :title="comment.uin ? `QQ ${comment.uin}` : undefined">
                    {{ comment.nickname || comment.uin || "QQ 用户" }}
                  </strong>
                  <span>评论于</span>
                  <time>{{ formatTime(comment.createdAt) || "时间未知" }}</time>
                </div>
                <p class="qzc-comment__text"><QzoneText :value="comment.content" /></p>

                <div v-if="comment.replies.length" class="qzc-replies">
                  <div
                    v-for="(reply, index) in comment.replies"
                    :key="`${reply.uin}-${reply.createdAt}-${index}`"
                    class="qzc-reply"
                  >
                    <span class="qzc-reply__avatar">
                      <img
                        v-if="reply.uin && !isBroken(avatarKey('c', reply.uin))"
                        :src="avatarUrl(reply.uin)"
                        :alt="reply.nickname || reply.uin"
                        loading="lazy"
                        decoding="async"
                        referrerpolicy="no-referrer"
                        @error="markBroken(avatarKey('c', reply.uin))"
                      />
                      <UserRound v-else :size="13" :stroke-width="1.8" aria-hidden="true" />
                    </span>
                    <div class="qzc-reply__body">
                      <div class="qzc-comment__meta">
                        <strong :title="reply.uin ? `QQ ${reply.uin}` : undefined">
                          {{ reply.nickname || reply.uin || "QQ 用户" }}
                        </strong>
                        <span>
                          回复
                          {{
                            reply.replyToNickname ||
                            reply.replyToUin ||
                            comment.nickname ||
                            comment.uin ||
                            "QQ 用户"
                          }}
                        </span>
                        <time>{{ formatTime(reply.createdAt) || "时间未知" }}</time>
                      </div>
                      <p class="qzc-comment__text"><QzoneText :value="reply.content" /></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
    </Drawer>
  </div>
</template>

<style scoped>
.qzc-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* ------------------------------------------------------------------ 筛选区 */

.qzc-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-5);
}

.qzc-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 200px;
  max-width: 320px;
  height: 36px;
  padding: 0 var(--space-3);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  transition: border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.qzc-search:focus-within {
  border-color: var(--color-accent);
  background: var(--color-surface);
  box-shadow: var(--shadow-focus);
}

.qzc-search__input,
.qzc-search__input:hover,
.qzc-search__input:focus {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--text-sm);
  color: var(--color-text);
}

.qzc-sort {
  flex: 0 0 auto;
  width: 152px;
}

.qzc-sort :deep(.p-select) {
  width: 100%;
}

.qzc-alert {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.qzc-alert__retry {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-danger);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.qzc-alert__retry:hover {
  text-decoration: underline;
}

/* ------------------------------------------------------------------ 名单 */

.qzc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-3);
}

.qzc-person {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
  transition: border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.qzc-person:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.qzc-person.is-top {
  border-color: var(--color-warm-border);
  background: var(--color-warm-soft);
}

/* 骨架块的底色与 sunken 太接近，单独给一层更亮的底板托住它。 */
.qzc-person.is-skeleton {
  gap: var(--space-2);
  background: var(--color-surface);
}

.qzc-person.is-skeleton:hover {
  border-color: var(--color-border);
  background: var(--color-surface);
}

.qzc-person__hit {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.qzc-person__hit:disabled {
  cursor: default;
}

.qzc-person__hit:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: var(--space-1);
  border-radius: var(--radius-md);
}

.qzc-person__identity {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}

.qzc-person__name {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--duration-fast) var(--ease-out);
}

.qzc-person__hit:not(:disabled):hover .qzc-person__name {
  color: var(--color-accent);
}

.qzc-person__uin {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.qzc-person__total {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}

.qzc-person__total strong {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.qzc-person.is-top .qzc-person__total strong {
  color: var(--color-warm);
}

.qzc-person__total small {
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.qzc-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: hidden;
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.qzc-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.qzc-avatar.is-base {
  width: 44px;
  height: 44px;
}

.qzc-avatar.is-strong {
  width: 48px;
  height: 48px;
}

.qzc-avatar.is-hero {
  width: 56px;
  height: 56px;
  border-color: var(--color-warm-border);
  font-size: var(--text-lg);
}

.qzc-person__meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding-top: var(--space-2);
  border-top: var(--line-width) dashed var(--color-border);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
}

.qzc-person.is-top .qzc-person__meta {
  border-top-color: var(--color-warm-border);
}

.qzc-person__meta > span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.qzc-rank {
  min-width: 22px;
  height: 18px;
  padding: 0 var(--space-1);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  justify-content: center;
}

.qzc-person.is-top .qzc-rank {
  border-color: var(--color-warm);
  background: var(--color-warm);
  color: var(--color-text-inverse);
  font-weight: var(--weight-medium);
}

.qzc-person__note {
  font-size: var(--text-2xs);
  color: var(--color-warm);
  font-weight: var(--weight-medium);
}

.qzc-sentinel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-1);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.qzc-foot {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

/* ------------------------------------------------------------ 评论往来抽屉 */

.qzc-subject {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-4);
  border-bottom: var(--line-width) solid var(--color-border);
}

.qzc-subject__copy {
  min-width: 0;
}

.qzc-subject__copy strong {
  display: block;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qzc-subject__copy small {
  display: block;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.qzc-subject__copy p {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.qzc-threads {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.qzc-thread {
  padding: var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
}

.qzc-thread.is-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--color-surface);
}

.qzc-thread__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.qzc-thread__time {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-warm);
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
}

.qzc-thread__content {
  margin: var(--space-3) 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text);
}

.qzc-comments {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.qzc-comment {
  display: flex;
  gap: var(--space-3);
}

.qzc-comment__avatar,
.qzc-reply__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-tertiary);
}

.qzc-comment__avatar {
  width: 28px;
  height: 28px;
}

.qzc-reply__avatar {
  width: 24px;
  height: 24px;
}

.qzc-comment__avatar img,
.qzc-reply__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.qzc-comment__body,
.qzc-reply__body {
  flex: 1;
  min-width: 0;
}

.qzc-comment__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: var(--text-2xs);
  color: var(--color-text-tertiary);
}

.qzc-comment__meta strong {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.qzc-comment__meta time {
  font-variant-numeric: tabular-nums;
}

.qzc-comment__text {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.qzc-replies {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-left: var(--focus-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.qzc-reply {
  display: flex;
  gap: var(--space-2);
}

/* ------------------------------------------------------------------ 窄屏 */

@media (max-width: 860px) {
  .qzc-search {
    max-width: none;
  }

  .qzc-sort {
    width: 100%;
  }

  .qzc-grid {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
}

.qzc-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:var(--space-4); }
@media (max-width:860px) { .qzc-stats { grid-template-columns:minmax(0,1fr); } }


/* Windows 优先的内容密度；触控布局仍共用相同功能和语义。 */
 .qzc-page { gap:var(--layout-page-gap); }
.qzc-grid { grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--layout-contact-cell)),1fr)); gap:var(--density-gap); }
.qzc-person { border-radius:var(--radius-md); box-shadow:none; }
.qzc-person:hover { border-color:var(--color-accent-border); box-shadow:var(--shadow-xs); }
.qzc-person__hit { min-height:var(--density-row-height); }
.qzc-person__total { font-variant-numeric:tabular-nums; }
.qzc-toolbar { gap:var(--space-3); }
@media(max-width:600px) { .qzc-grid { grid-template-columns:minmax(0,1fr); } }
</style>
