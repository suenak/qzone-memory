<script setup lang="ts">
import type { Component } from "vue";

/**
 * 空状态。
 *
 * 要求：不只说「没有数据」，而要解释**为什么**没有，并在可能时给出下一步操作。
 * 这是产品里出现频率最高的状态之一，不能只是一个灰色图标。
 */
withDefaults(
  defineProps<{
    icon?: Component;
    title: string;
    description?: string;
    tone?: "neutral" | "warm" | "danger";
    /** 紧凑模式用于卡片内部的小块空白区域。 */
    compact?: boolean;
  }>(),
  { tone: "neutral", compact: false },
);
</script>

<template>
  <div class="qza-empty" :class="[`is-${tone}`, { 'is-compact': compact }]">
    <span v-if="icon" class="qza-empty__icon" aria-hidden="true">
      <component :is="icon" :size="compact ? 20 : 26" :stroke-width="1.6" />
    </span>
    <div class="qza-empty__copy">
      <h4 class="qza-empty__title">{{ title }}</h4>
      <p v-if="description" class="qza-empty__description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="qza-empty__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.qza-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-3);
  padding: var(--space-10) var(--space-5);
}

.qza-empty.is-compact {
  padding: var(--space-6) var(--space-4);
  gap: var(--space-2);
}

.qza-empty__icon {
  display: grid;
  place-items: center;
  width: var(--layout-empty-icon);
  height: var(--layout-empty-icon);
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.is-compact .qza-empty__icon {
  width: var(--control-height);
  height: var(--control-height);
}

.qza-empty.is-warm .qza-empty__icon {
  background: var(--color-warm-soft);
  color: var(--color-warm);
}

.qza-empty.is-danger .qza-empty__icon {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.qza-empty__copy {
  max-width: 44ch;
}

.qza-empty__title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.qza-empty__description {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  color: var(--color-text-secondary);
}

.qza-empty__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
  justify-content: center;
  flex-wrap: wrap;
}
</style>
