<script setup lang="ts">
const props = defineProps({ label: { type: String, required: true }, tone: String });
</script>
<template><span>{{ props.label }}</span></template>
