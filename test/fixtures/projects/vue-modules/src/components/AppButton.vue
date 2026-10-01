<script setup lang="ts">
defineProps<{
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}>();
</script>

<template>
  <button :class="[$style.button, $style[variant ?? 'primary']]" :disabled="disabled"><slot /></button>
</template>

<style module>
.button { border-radius: 8px; }
</style>
