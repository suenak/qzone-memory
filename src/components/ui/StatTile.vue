<script setup lang="ts">
import type { Component } from "vue";
import SkeletonBlock from "./SkeletonBlock.vue";

/**
 * 统计数字块。
 *
 * 数值必须来自真实后端。loading 为 true 时渲染骨架，
 * 而不是显示 0 或占位数字——那会造成「数据为空」的误判。
 */
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    icon?: Component;
    tone?: "accent" | "warm" | "success" | "neutral";
    loading?: boolean;
  }>(),
  { tone: "neutral", loading: false },
);
</script>

<template>
  <article class="qza-stat" :class="`is-${tone}`">
    <span v-if="icon" class="qza-stat__icon" aria-hidden="true">
      <component :is="icon" :size="18" :stroke-width="1.8" />
    </span>
    <div class="qza-stat__body">
      <p class="qza-stat__label">{{ label }}</p>
      <SkeletonBlock v-if="loading" width="72px" height="26px" />
      <strong v-else class="qza-stat__value">{{ value }}</strong>
      <p v-if="hint" class="qza-stat__hint">{{ hint }}</p>
    </div>
  </article>
</template>

<style scoped>
.qza-stat {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--density-card-padding, var(--space-5));
  background: var(--color-surface);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
}

.qza-stat__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}

.qza-stat.is-accent .qza-stat__icon {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.qza-stat.is-warm .qza-stat__icon {
  background: var(--color-warm-soft);
  color: var(--color-warm);
}

.qza-stat.is-success .qza-stat__icon {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.qza-stat__body {
  min-width: 0;
}

.qza-stat__label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.qza-stat__value {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  line-height: 1.15;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.qza-stat__hint {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-tertiary);
}
</style>
