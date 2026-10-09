<script setup lang="ts">
/**
 * 骨架屏。
 *
 * 数据未就绪时一律用它，绝不用随机数字或占位文本伪造内容——
 * 那会让用户以为数据已经加载完成。
 */
withDefaults(
  defineProps<{
    width?: string;
    height?: string;
    /** 圆形用于头像位。 */
    circle?: boolean;
    /** 渲染多行，最后一行自动收窄，更接近真实文本的观感。 */
    lines?: number;
  }>(),
  { height: "14px", circle: false, lines: 1 },
);
</script>

<template>
  <div class="qza-skeleton-stack" :aria-busy="true" aria-live="polite">
    <span class="qza-visually-hidden">正在加载</span>
    <span
      v-for="index in lines"
      :key="index"
      class="qza-skeleton"
      :class="{ 'is-circle': circle }"
      :style="{
        width: lines > 1 && index === lines ? '62%' : width,
        height: circle ? width : height,
      }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.qza-skeleton-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.qza-skeleton {
  display: block;
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    var(--color-surface-sunken) 25%,
    var(--color-border) 37%,
    var(--color-surface-sunken) 63%
  );
  background-size: 400% 100%;
  animation: qza-skeleton-shimmer 1.4s ease infinite;
}

.qza-skeleton.is-circle {
  border-radius: var(--radius-full);
}

@keyframes qza-skeleton-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .qza-skeleton {
    animation: none;
    background: var(--color-surface-sunken);
  }
}
</style>
