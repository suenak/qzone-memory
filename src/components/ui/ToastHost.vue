<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";

const { items, dismiss } = useToast();

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info } as const;
</script>

<template>
  <div class="qza-toast-host" role="status" aria-live="polite">
    <TransitionGroup name="qza-toast">
      <div v-for="item in items" :key="item.id" class="qza-toast" :class="`is-${item.tone}`">
        <component :is="ICONS[item.tone]" class="qza-toast__icon" :size="16" :stroke-width="2" />
        <span class="qza-toast__text">{{ item.message }}</span>
        <button class="qza-toast__close" type="button" aria-label="关闭提示" @click="dismiss(item.id)">
          <X :size="13" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.qza-toast-host {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  pointer-events: none;
}

.qza-toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  max-width: min(420px, calc(100vw - 40px));
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  border: var(--line-width) solid var(--color-border);
  border-left: 3px solid var(--color-text-tertiary);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
  pointer-events: auto;
}

.qza-toast.is-success {
  border-left-color: var(--color-success);
}

.qza-toast.is-success .qza-toast__icon {
  color: var(--color-success);
}

.qza-toast.is-error {
  border-left-color: var(--color-danger);
}

.qza-toast.is-error .qza-toast__icon {
  color: var(--color-danger);
}

.qza-toast.is-info .qza-toast__icon {
  color: var(--color-accent);
}

.qza-toast__icon {
  flex-shrink: 0;
  margin-top: var(--line-width);
  color: var(--color-text-tertiary);
}

.qza-toast__text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.qza-toast__close {
  position: relative;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-tertiary);
}
.qza-toast__close::after { content:""; position:absolute; width:var(--touch-target); height:var(--touch-target); top:50%; left:50%; transform:translate(-50%, -50%); }

.qza-toast__close:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}

.qza-toast-enter-active,
.qza-toast-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.qza-toast-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.qza-toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
