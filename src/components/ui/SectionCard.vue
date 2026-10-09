<script setup lang="ts">
/**
 * 通用卡片容器。
 *
 * 页面里几乎所有成块内容都放在它里面，从而保证圆角、边框、内边距、
 * 标题排版在全应用范围内一致。业务样式通过默认插槽自带，不进这里。
 */
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    /** 关闭内边距，供表格、列表等自带边距的内容使用。 */
    flush?: boolean;
  }>(),
  { flush: false },
);
</script>

<template>
  <section class="qza-card">
    <header v-if="title || description || $slots.actions" class="qza-card__head">
      <div class="qza-card__titles">
        <h3 v-if="title" class="qza-card__title">{{ title }}</h3>
        <p v-if="description" class="qza-card__description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="qza-card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="qza-card__body" :class="{ 'is-flush': flush }">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="qza-card__foot">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.qza-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-surface);
  border: var(--line-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}

.qza-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--density-card-padding, var(--space-5));
  border-bottom: var(--line-width) solid var(--color-border);
}

.qza-card__titles {
  min-width: 0;
}

.qza-card__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}

.qza-card__description {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-secondary);
}

.qza-card__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.qza-card__body {
  flex: 1;
  min-height: 0;
  padding: var(--density-card-padding, var(--space-5));
}

.qza-card__body.is-flush {
  padding: 0;
}

.qza-card__foot {
  padding: var(--density-card-padding, var(--space-5));
  border-top: var(--line-width) solid var(--color-border);
  background: var(--color-surface);
}

@media (max-width: 600px) {
  .qza-card__head { flex-wrap: wrap; gap: var(--space-3); }
  .qza-card__actions { justify-content: flex-start; }
}
</style>
