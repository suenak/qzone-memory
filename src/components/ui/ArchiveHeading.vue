<script setup lang="ts">
import type { Component } from "vue";
defineProps<{ eyebrow?: string; title: string; description?: string; icon?: Component }>();
</script>

<template>
  <header class="archive-heading">
    <div class="archive-heading__copy">
      <p v-if="eyebrow" class="archive-heading__eyebrow"><component v-if="icon" :is="icon" :size="14" :stroke-width="1.8" aria-hidden="true" />{{ eyebrow }}</p>
      <h2>{{ title }}</h2>
      <p v-if="description" class="archive-heading__description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="archive-heading__actions"><slot /></div>
  </header>
</template>

<style scoped>
.archive-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-6); min-width: 0; padding: var(--space-2) 0 var(--space-4); }
.archive-heading__copy { min-width: 0; }
.archive-heading__eyebrow { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); color: var(--color-text-secondary); font-size: var(--text-xs); font-weight: var(--weight-medium); }
h2 { font-size: var(--text-3xl); letter-spacing: -0.035em; font-weight: var(--weight-semibold); line-height: var(--leading-tight); }
.archive-heading__description { margin-top: var(--space-3); max-width: 64ch; color: var(--color-text-secondary); font-size: var(--text-sm); line-height: var(--leading-relaxed); }
.archive-heading__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); flex-shrink: 0; }
@media (max-width: 860px) { .archive-heading { align-items: flex-start; flex-direction: column; gap: var(--space-3); } h2 { font-size: var(--text-2xl); } }
</style>
