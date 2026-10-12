<script setup lang="ts">
import type { Component } from "vue";
defineProps<{ eyebrow?: string; title: string; description?: string; icon?: Component }>();
</script>

<template>
  <header class="archive-heading" :aria-label="title">
    <span v-if="icon" class="archive-heading__icon" aria-hidden="true"><component :is="icon" :size="18" :stroke-width="1.8" /></span>
    <div class="archive-heading__copy">
      <p v-if="eyebrow" class="archive-heading__eyebrow"><component v-if="icon" :is="icon" :size="14" :stroke-width="1.8" aria-hidden="true" />{{ eyebrow }}</p>
      <h2 class="qza-visually-hidden">{{ title }}</h2>
      <p v-if="description" class="archive-heading__description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="archive-heading__actions"><slot /></div>
  </header>
</template>

<style scoped>
.archive-heading { display:flex; align-items:center; gap:var(--space-3); min-width:0; padding-block:var(--space-1); }
.archive-heading__icon { display:grid; place-items:center; flex-shrink:0; width:var(--control-height); height:var(--control-height); border:var(--line-width) solid var(--color-border); border-radius:var(--radius-md); color:var(--color-accent); background:var(--color-surface); }
.archive-heading__copy { flex:1; min-width:0; }
.archive-heading__eyebrow { display:flex; align-items:center; gap:var(--space-2); color:var(--color-text-secondary); font-size:var(--text-xs); }
.archive-heading__description { max-width:72ch; color:var(--color-text-secondary); font-size:var(--text-sm); line-height:var(--leading-normal); }
.archive-heading__actions { display:flex; flex-wrap:wrap; gap:var(--space-2); margin-left:auto; }
@media(max-width:600px) { .archive-heading { flex-wrap:wrap; } .archive-heading__actions { margin-left:calc(var(--control-height) + var(--space-3)); } }
</style>
