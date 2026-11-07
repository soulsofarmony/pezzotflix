# R8 rules of the release build. Media3, OkHttp, Retrofit, kotlinx-serialization and Coil ship their own consumer
# rules; these cover what is ours and is reached by reflection.

# Generated API (contract): Retrofit reads the interfaces' annotations and generic return types; the models are
# (de)serialized by kotlinx-serialization through their generated serializers, looked up from the type.
-keep interface dev.pezzotflix.api.apis.** { *; }
-keep class dev.pezzotflix.api.models.** { *; }
-keep interface dev.pezzotflix.tv.api.PlaybackBodiesApi { *; }

# Retrofit with suspend functions: the Continuation's and Response's type arguments are read at runtime.
-keepattributes Signature, InnerClasses, EnclosingMethod, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations, AnnotationDefault
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-keep,allowobfuscation,allowshrinking class retrofit2.Response

# kotlinx-serialization: companions and serializers of our own @Serializable classes (bodies, events).
-keepclassmembers @kotlinx.serialization.Serializable class dev.pezzotflix.** {
    static ** Companion;
    *** serializer(...);
}

# Readable stack traces in the TV's logcat.
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile
